import {
    AccessProfileEntitlement,
    Account,
    AttributeDefinition,
    FormDefinitionResponseBeta,
    FormInstanceResponseBeta,
    IdentityAccess,
    IdentityDocument,
    OwnerDto,
    Schema,
    Source,
    WorkflowBeta,
} from 'sailpoint-api-client'
import { Config } from './model/config'
import { SDKClient } from './sdk-client'
import {
    AccountSchema,
    ConnectorError,
    ConnectorErrorType,
    Context,
    SchemaAttribute,
    logger,
} from '@sailpoint/connector-sdk'
import {
    attrConcat,
    attrSplit,
    buildAccountAttributesObject,
    buildIdentityAttributesObject,
    composeErrorMessage,
    datedMessage,
    getExpirationDate,
    getInputFromDescription,
    getOwnerFromSource,
    lm,
    normalizeAccountAttributes,
    deleteArrayItem,
    stringifyIdentity,
    stringifyScore,
} from './utils'
import { EDIT_FORM_NAME, UNIQUE_FORM_NAME, WORKFLOW_NAME, reservedAttributes } from './constants'
import { EditForm, UniqueForm } from './model/form'
import { buildUniqueID } from './utils/unique'
import { ReviewEmail, ErrorEmail, ReportEmail } from './model/email'
import { AccountAnalysis, SimilarAccountMatch, UniqueAccount } from './model/account'
import { AxiosError } from 'axios'
import { v4 as uuidv4 } from 'uuid'
import { EmailWorkflow } from './model/emailWorkflow'
import { statuses } from './data/status'
import { Status } from './model/status'
import { Action, ActionSource } from './model/action'
import { actions } from './data/action'
import { lig3 } from './utils/lig'

export class ContextHelper {
    private c: string = 'ContextHelper'
    private emailer?: WorkflowBeta
    private sources: Source[]
    private client: SDKClient
    private config: Config
    private reviewerIDs: Map<string, string[]>
    private source?: Source
    private schema?: AccountSchema
    private ids: string[]
    private identities: IdentityDocument[]
    private currentIdentities: IdentityDocument[]
    private accounts: Account[]
    private authoritativeAccounts: Account[]
    private uniqueForms: FormDefinitionResponseBeta[]
    private uniqueFormInstances: FormInstanceResponseBeta[]
    private editForms: FormDefinitionResponseBeta[]
    private editFormInstances: FormInstanceResponseBeta[]
    private forms: FormDefinitionResponseBeta[]
    private errors: string[]
    private uuids: string[]
    private baseUrl: string
    private initiated: string | undefined
    private mergingEnabled: boolean = false

    constructor(config: Config) {
        this.config = config
        this.sources = []
        this.ids = []
        this.uuids = []
        this.identities = []
        this.currentIdentities = []
        this.accounts = []
        this.authoritativeAccounts = []
        this.uniqueForms = []
        this.uniqueFormInstances = []
        this.editForms = []
        this.forms = []
        this.editFormInstances = []
        this.errors = []
        this.reviewerIDs = new Map<string, string[]>()

        logger.debug(lm(`Initializing SDK client.`, this.c))
        this.client = new SDKClient(this.config)

        this.config!.merging_map = this.config?.merging_map || []
        this.config.getScore = (attribute?: string): number => {
            let score
            if (this.config.global_merging_score) {
                score = this.config.merging_score
            } else {
                const attributeConfig = this.config.merging_map.find((x) => x.identity === attribute)
                score = attributeConfig?.merging_score
            }

            return score ? score : 0
        }

        this.baseUrl = new URL(this.config.baseurl.replace('.api.', '.')).origin
    }

    async init(schema?: AccountSchema, skipData?: boolean) {
        if (!this.initiated) {
            logger.debug(lm(`Looking for connector instance`, this.c))
            if (schema) {
                this.loadSchema(schema)
            }
            const id = this.config!.spConnectorInstanceId as string
            const allSources = await this.client.listSources()
            this.source = allSources.find((x) => (x.connectorAttributes as any).spConnectorInstanceId === id)
            this.sources = allSources.filter((x) => this.config?.sources.includes(x.name))

            if (!this.source) {
                throw new ConnectorError('No connector source was found on the tenant.')
            }

            const owner = getOwnerFromSource(this.source)
            const wfName = `${WORKFLOW_NAME} (${this.config!.cloudDisplayName})`
            this.emailer = await this.getEmailWorkflow(wfName, owner)

            this.identities = []
            this.accounts = []
            this.authoritativeAccounts = []
            this.currentIdentities = []
            this.uniqueForms = []
            this.uniqueFormInstances = []
            this.editForms = []
            this.editFormInstances = []
            this.errors = []
            this.initiated = 'partial'
        }

        if (!skipData && this.initiated === 'partial') {
            this.identities = await this.listIdentities()
            this.accounts = await this.listAccounts()
            this.reviewerIDs = await this.buildReviewersMap()
            this.mergingEnabled = this.config.merging_isEnabled && this.listAllReviewerIDs().length > 0
            const identityIDs = this.accounts.map((x) => x.identityId)
            this.uuids = this.accounts.map((x) => x.attributes!.uuid).filter((x) => x !== undefined)
            this.authoritativeAccounts = await this.fetchAuthoritativeAccounts()
            this.currentIdentities = this.identities.filter((x) => identityIDs.includes(x.id))
            await this.loadForms()

            if (this.config.uid_scope === 'source') {
                logger.info('Compiling current IDs for source scope.')
                this.ids = this.accounts.map((x) => x.attributes!.uniqueID)
            } else {
                logger.info('Compiling current IDs for tenant scope.')
                this.ids = this.identities.map((x) => x.attributes!.uid)
            }

            this.initiated = 'full'
        }
    }

    getSource(): Source {
        if (this.source) {
            return this.source
        } else {
            throw new ConnectorError('No connector source was found on the tenant.')
        }
    }

    listSources(): Source[] {
        return this.sources
    }

    async listReviewerIDs(source?: string): Promise<string[]> {
        if (this.initiated !== 'full') {
            this.reviewerIDs = await this.buildReviewersMap()
        }
        if (source) {
            return this.reviewerIDs.get(source) || []
        } else {
            return Array.from(new Set(Array.from(this.reviewerIDs.values()).flat()))
        }
    }

    listAllReviewerIDs(): string[] {
        const ids = Array.from(this.reviewerIDs.values()).flat()

        return Array.from(new Set(ids))
    }

    deleteReviewerID(reviewerID: string, sourceName: string) {
        const reviewers = this.reviewerIDs.get(sourceName)
        if (reviewers) {
            deleteArrayItem(reviewers, reviewerID)
        }
    }

    isFirstRun(): boolean {
        return this.accounts.length === 0
    }

    private async listIdentities(): Promise<IdentityDocument[]> {
        const c = 'listIdentities'
        logger.info(lm('Fetching identities.', c))
        const identities = await this.client.listIdentities()

        return identities ? identities : []
    }

    async getIdentityById(id: string): Promise<IdentityDocument | undefined> {
        let identity: IdentityDocument | undefined
        if (this.initiated === 'full') {
            identity = this.identities.find((x) => x.id === id)
        } else {
            identity = await this.client.getIdentityBySearch(id)
        }

        return identity
    }

    async getIdentityByUID(uid: string): Promise<IdentityDocument | undefined> {
        if (this.identities.length > 0) {
            return this.identities.find((x) => x.attributes!.uid === uid)
        } else {
            const identity = await this.client.getIdentityByUID(uid)
            this.identities.push(identity!)
            return identity
        }
    }

    private async listAccounts(): Promise<Account[]> {
        const c = 'listAccounts'
        const source = this.getSource()

        logger.info(lm('Fetching existing accounts.', c))
        let accounts = await this.client.listAccountsBySource(source.id!)
        accounts = accounts || []

        for (const account of accounts) {
            account.attributes!.accounts = account.attributes!.accounts || []
            account.attributes!.statuses = account.attributes!.statuses || []
            account.attributes!.actions = account.attributes!.actions || []
            account.attributes!.reviews = account.attributes!.reviews || []
            account.attributes!.history = account.attributes!.history || []
        }

        if (this.config.deleteEmpty) {
            accounts = accounts.filter((x) => !x.attributes!.statuses.includes('orphan'))
        }

        return accounts
    }

    listProcessedAccountIDs(): string[] {
        return this.accounts.map((x) => x.attributes!.accounts).flat()
    }

    async getAccount(id: string): Promise<Account | undefined> {
        const account = await this.client.getAccount(id)

        return account
    }

    async getFusionAccount(id: string): Promise<Account | undefined> {
        let account
        if (this.initiated === 'full') {
            account = this.accounts.find((x) => x.nativeIdentity === id)
        } else {
            account = await this.client.getAccountBySourceAndNativeIdentity(this.getSource().id!, id)
        }

        return account
    }

    async getAccountByIdentity(identity: IdentityDocument): Promise<Account | undefined> {
        let account = this.accounts.find((x) => x.identityId === identity.id)
        if (!account) {
            account = await this.client.getAccountByIdentityID(
                identity.id,
                identity.attributes!.cloudAuthoritativeSource
            )
        }

        return account
    }

    getIdentityAccount(identity: IdentityDocument): Account | undefined {
        return this.accounts.find((x) => x.identityId === identity.id)
    }

    listCurrentIdentityIDs(): string[] {
        return this.accounts.map((x) => x.identityId!)
    }

    async listAuthoritativeAccounts(): Promise<Account[]> {
        return this.authoritativeAccounts
    }

    private async fetchAuthoritativeAccounts(): Promise<Account[]> {
        const c = 'fetchAuthoritativeAccounts'

        logger.info(lm('Fetching authoritative accounts.', c))
        const authoritativeAccounts = await this.client.listAccounts(this.sources.map((x) => x.id!))

        return authoritativeAccounts
    }

    setUUID(account: Account) {
        while (!account.attributes!.uuid) {
            const uuid = uuidv4()
            if (!this.uuids.includes(uuid)) {
                this.uuids.push(uuid)
                account.attributes!.uuid = uuid
            }
        }
    }

    async *listUniqueAccounts(): AsyncGenerator<UniqueAccount> {
        const c = 'listUniqueAccounts'

        logger.debug(lm('Updating accounts.', c))
        for (const account of this.accounts) {
            const uniqueAccount = await this.refreshUniqueAccount(account)
            if (uniqueAccount) {
                yield uniqueAccount
            }
        }
    }

    private async getAccountIdentity(account: Account): Promise<IdentityDocument | undefined> {
        let identity: IdentityDocument | undefined
        if (this.initiated === 'full') {
            identity = this.identities.find((x) => x.id === account.identityId)
        } else {
            identity = await this.client.getIdentityBySearch(account.identityId!)
        }

        return identity
    }

    private async listSourceAccounts(account: Account): Promise<Account[]> {
        let sourceAccounts: Account[] = []

        if (account.uncorrelated) {
            sourceAccounts.push(account)
        } else {
            if (this.initiated === 'full') {
                for (const sourceName of this.config.sources) {
                    const accounts = this.authoritativeAccounts.filter(
                        (x) => x.sourceName === sourceName && account.attributes!.accounts.includes(x.id)
                    )
                    sourceAccounts = sourceAccounts.concat(accounts)
                }
            } else {
                const accounts = await this.client.getAccountsByIdentity(account.identityId!)
                sourceAccounts = accounts.filter((x) => this.config.sources.includes(x.sourceName))
            }
        }

        return sourceAccounts
    }

    async refreshUniqueAccount(account: Account): Promise<UniqueAccount> {
        const c = 'refreshUniqueAccount'

        const sourceAccounts = await this.listSourceAccounts(account)
        let needsRefresh = false
        let sourceAccountsChanged = false

        if (account.uncorrelated) {
            logger.debug(lm(`New account. Needs to be enabled.`, c, 2))
        } else {
            logger.debug(lm(`Existing account. Enforcing defined correlation.`, c, 1))
            // if (!identity) {
            //     let count = 0
            //     let wait = IDENTITYNOTFOUNDWAIT
            //     while (!identity) {
            //         identity = await this.client.getIdentityBySearch(account.identityId!)
            //         if (!identity) {
            //             if (++count > IDENTITYNOTFOUNDRETRIES)
            //                 throw new Error(
            //                     `Identity ${account.identityId} for account ${account.nativeIdentity} not found`
            //                 )

            //             logger.warn(lm(`Identity ID ${account.identityId} not found. Re-trying...`, c, 1))
            //             await sleep(wait)
            //             wait = wait + IDENTITYNOTFOUNDWAIT
            //         }
            //     }
            // }
            const identity = await this.getAccountIdentity(account)

            if (identity) {
                const accounts = identity.accounts!
                const originalAccountIds = [...account.attributes!.accounts]
                const accountIds = accounts
                    .filter((x) => this.config.sources.includes(x.source!.name!))
                    .map((x) => x.id!)

                for (const acc of account.attributes!.accounts as string[]) {
                    const uid: string = (identity.attributes as any).uid
                    try {
                        if (
                            !accountIds.includes(acc) &&
                            (this.initiated === 'partial' || this.authoritativeAccounts.find((x) => x.id === acc))
                        ) {
                            logger.debug(lm(`Correlating ${acc} account with ${uid}.`, c, 1))
                            const response = await this.client.correlateAccount(identity.id as string, acc)
                            accountIds.push(acc)
                        }
                    } catch (e) {
                        logger.error(lm(`Failed to correlate ${acc} account with ${uid}.`, c, 1))
                    }
                    account.attributes!.accounts = accountIds
                    if (
                        !originalAccountIds.every((item) => accountIds.includes(item)) ||
                        !accountIds.every((item) => originalAccountIds.includes(item))
                    ) {
                        sourceAccountsChanged = true
                    }
                }
            }
        }

        if (account.uncorrelated) {
            needsRefresh = true
            this.setUUID(account)
        } else {
            if (sourceAccountsChanged) {
                needsRefresh = true
            } else {
                if (!account.attributes!.statuses.includes('edited')) {
                    const lastConfigChange = new Date(this.source!.modified!).getTime()
                    const lastModified = new Date(account.modified!).getTime()
                    if (lastModified < lastConfigChange) {
                        needsRefresh = true
                    } else {
                        const newSourceData = sourceAccounts.find((x) => new Date(x.modified!).getTime() > lastModified)
                        needsRefresh = newSourceData ? true : false
                    }
                }
            }
        }

        const schema = await this.getSchema()
        try {
            const attributes = account.attributes
            if (needsRefresh) {
                logger.debug(lm(`Refreshing ${account.attributes!.uniqueID} account`, c, 1))

                attributes: for (const attrDef of schema.attributes) {
                    if (!reservedAttributes.includes(attrDef.name)) {
                        const attrConf = this.config.merging_map.find((x) => x.identity === attrDef.name)
                        const attributeMerge = attrConf?.attributeMerge || this.config.attributeMerge
                        let multiValue: string[] = []
                        let firstSource = true
                        accounts: for (const sourceAccount of sourceAccounts) {
                            let values: any[] = []
                            let value: any
                            if (attrConf) {
                                //First account attribute found goes
                                accountAttributes: for (const accountAttr of attrConf.account) {
                                    if (!sourceAccount.attributes) {
                                        const message = `Account ${sourceAccount.nativeIdentity} has no attributes`
                                        logger.warn(message)
                                        continue
                                    }
                                    value = sourceAccount.attributes![accountAttr]
                                    if (value) {
                                        values.push(value)
                                        if (['first', 'source'].includes(attributeMerge)) break accountAttributes
                                    }
                                }
                            } else {
                                value = sourceAccount.attributes![attrDef.name]
                                if (value) values.push(value)
                            }

                            if (values.length > 0) {
                                values = values.map((x) => attrSplit(x))

                                if (['multi', 'concatenate'].includes(attributeMerge)) {
                                    multiValue = multiValue.concat(values).flat()
                                }
                                values: for (const value of values) {
                                    switch (attributeMerge) {
                                        case 'first':
                                            if (firstSource) {
                                                if (value.length === 1) {
                                                    attributes![attrDef.name] = value[0]
                                                } else {
                                                    attributes![attrDef.name] = value
                                                }
                                                firstSource = false
                                                break accounts
                                            }
                                            break

                                        case 'source':
                                            const source = attrConf?.source
                                            if (sourceAccount.sourceName === source) {
                                                if (value.length === 1) {
                                                    attributes![attrDef.name] = value[0]
                                                } else {
                                                    attributes![attrDef.name] = value
                                                }
                                                break accounts
                                            }
                                            break
                                        default:
                                            break
                                    }
                                }
                            }
                        }

                        switch (attributeMerge) {
                            case 'multi':
                                attributes![attrDef.name] = [...new Set(multiValue)].sort()
                                break

                            case 'concatenate':
                                attributes![attrDef.name] = attrConcat([...new Set(multiValue)].sort())
                                break

                            default:
                                break
                        }
                    }
                }

                attributes!.statuses = Array.from(new Set(attributes!.statuses))
            }
        } catch (error) {
            logger.error(error as string)
        }

        const uniqueAccount = new UniqueAccount(account, schema)

        return uniqueAccount
    }

    async buildReport(id: string) {
        const fusionAccount = (await this.getFusionAccount(id)) as Account
        const identity = (await this.getIdentityById(fusionAccount.identityId!)) as IdentityDocument
        const authoritativeAccounts = await this.listAuthoritativeAccounts()
        const pendingAccounts = authoritativeAccounts.filter((x) => x.uncorrelated === true)
        const analysis = await Promise.all(pendingAccounts.map((x) => this.analyzeUncorrelatedAccount(x)))

        const email = new ReportEmail(analysis, this.config.merging_attributes, identity)
        this.sendEmail(email)
    }

    async buildUniqueAccount(account: Account, status: string | string[], msg: string): Promise<Account> {
        const c = 'buildUniqueAccount'
        logger.debug(lm(`Processing ${account.name} (${account.id})`, c, 1))
        let uniqueID: string

        const uniqueAccount = account

        uniqueAccount.attributes!.accounts = [account.id]
        if (status !== 'reviewer') {
            uniqueID = await buildUniqueID(account, this.ids, this.config, true)
        } else {
            logger.debug(lm(`Taking identity uid as unique ID`, c, 1))
            const identity = this.identities.find((x) => x.id === account.identityId) as IdentityDocument
            uniqueID = identity?.attributes!.uid
        }

        uniqueAccount.attributes!.uniqueID = uniqueID
        uniqueAccount.attributes!.statuses = [status]
        uniqueAccount.attributes!.actions = []
        uniqueAccount.attributes!.reviews = []
        uniqueAccount.attributes!.history = []
        uniqueAccount.modified = new Date(0).toISOString()

        if (msg) {
            const message = datedMessage(msg, account)
            uniqueAccount.attributes!.history = [message]
        }

        this.ids.push(uniqueAccount.attributes!.uniqueID)
        this.accounts.push(uniqueAccount)

        return uniqueAccount
    }

    getSourceNameByID(id: string): string {
        const source = this.sources.find((x) => x.id === id)

        return source?.name ? source.name : ''
    }

    async buildUniqueAccountFromID(id: string): Promise<UniqueAccount> {
        const c = 'buildUniqueAccountFromID'

        logger.debug(lm(`Fetching original account`, c, 1))
        const account = await this.getFusionAccount(id)

        if (account) {
            account.attributes!.accounts = account.attributes!.accounts || []
            account.attributes!.actions = account.attributes!.actions || []
            account.attributes!.reviews = account.attributes!.reviews || []
            account.modified = new Date(0).toISOString()
            const uniqueAccount = await this.refreshUniqueAccount(account)
            return uniqueAccount
        } else {
            throw new ConnectorError('Account not found', ConnectorErrorType.NotFound)
        }
    }

    async buildUniqueID(id: string): Promise<string> {
        const account = await this.client.getAccountBySourceAndNativeIdentity(this.source!.id!, id)
        if (this.config.uid_scope === 'source') {
            logger.info('Compiling current IDs for source scope.')
            this.accounts = await this.listAccounts()
            this.ids = this.accounts.map((x) => x.attributes!.uniqueID)
        } else {
            logger.info('Compiling current IDs for tenant scope.')
            this.identities = await this.listIdentities()
            this.ids = this.identities.map((x) => x.attributes!.uid)
        }

        const uniqueID = await buildUniqueID(account!, this.ids, this.config, false)

        return uniqueID
    }

    addUniqueForm(form: FormDefinitionResponseBeta) {
        this.uniqueForms.push(form)
    }

    getUniqueFormName(account?: Account, sourceName?: string): string {
        let name: string
        if (account) {
            name = `${UNIQUE_FORM_NAME} (${sourceName}) - ${account.name} (${account.nativeIdentity})`
        } else {
            name = `${UNIQUE_FORM_NAME}`
        }
        return name
    }

    getEditFormName(accountName?: string): string {
        let name: string
        if (accountName) {
            name = `${EDIT_FORM_NAME} for ${accountName}`
        } else {
            name = `${EDIT_FORM_NAME}`
        }
        return name
    }

    listUniqueFormInstancesByForm(form: FormDefinitionResponseBeta): FormInstanceResponseBeta[] {
        return this.uniqueFormInstances.filter((x) => x.formDefinitionId === form.id)
    }

    listEditFormInstancesByForm(form: FormDefinitionResponseBeta): FormInstanceResponseBeta[] {
        return this.editFormInstances.filter((x) => x.formDefinitionId === form.id)
    }

    listUniqueFormInstancesByReviewerID(reviewerID: string): FormInstanceResponseBeta[] {
        const formInstances = this.uniqueFormInstances.filter((x) => x.recipients!.find((y) => y.id === reviewerID))
        return formInstances ? formInstances : []
    }

    getFormByID(id: string): FormDefinitionResponseBeta | undefined {
        return this.forms.find((x) => x.id === id)
    }

    getUniqueFormInstanceByReviewerID(
        form: FormDefinitionResponseBeta,
        reviewerID: string
    ): FormInstanceResponseBeta | undefined {
        return this.uniqueFormInstances.find(
            (x) => x.formDefinitionId === form.id && x.recipients!.find((y) => y.id === reviewerID)
        )
    }

    getEditFormInstanceByReviewerID(form: FormDefinitionResponseBeta, reviewerID: string) {
        return this.editFormInstances.find(
            (x) => x.formDefinitionId === form.id && x.recipients!.find((y) => y.id === reviewerID)
        )
    }

    private async loadForms() {
        this.forms = await this.client.listForms()
        this.uniqueForms = this.forms.filter((x) => x.name?.startsWith(this.getUniqueFormName()))
        this.editForms = this.forms.filter((x) => x.name?.startsWith(this.getEditFormName()))

        let formInstances = await this.client.listFormInstances()

        formInstances = formInstances.sort((a, b) => new Date(a.modified!).valueOf() - new Date(b.modified!).valueOf())
        const uniqueFormIDs = this.uniqueForms.map((x) => x.id)
        this.uniqueFormInstances = formInstances.filter((x) => uniqueFormIDs.includes(x.formDefinitionId))
        const editFormIDs = this.editForms.map((x) => x.id)
        this.editFormInstances = formInstances.filter((x) => editFormIDs.includes(x.formDefinitionId))
    }

    async listUniqueForms(): Promise<FormDefinitionResponseBeta[]> {
        return this.uniqueForms
    }

    async listEditForms(): Promise<FormDefinitionResponseBeta[]> {
        return this.editForms
    }

    async createUniqueForm(form: UniqueForm): Promise<FormDefinitionResponseBeta> {
        const c = 'createUniqueForm'
        const existingForm = this.uniqueForms.find((x) => x.name === form.name)
        if (existingForm) {
            logger.info(lm(`Form ${form.name} already exists`, c))
            return existingForm
        } else {
            const response = await this.client.createForm(form)
            this.uniqueForms.push(response)
            return response
        }
    }

    async createEditForm(account: UniqueAccount): Promise<FormDefinitionResponseBeta> {
        const name = this.getEditFormName(account.attributes.uniqueID as string)
        const owner = this.source!.owner
        const attributes = Object.keys(account.attributes).filter((x) => !reservedAttributes.includes(x))
        const form = new EditForm(name, owner, account, attributes)
        const response = await this.client.createForm(form)

        return response
    }

    async deleteUniqueForm(form: FormDefinitionResponseBeta) {
        await this.client.deleteForm(form.id!)

        const index = this.uniqueForms.findIndex((x) => x.id === form.id!)
        this.uniqueForms.splice(index, 1)
    }

    async deleteEditForm(form: FormDefinitionResponseBeta) {
        await this.client.deleteForm(form.id!)
    }

    // async listEditFormInstances(forms?: FormDefinitionResponseBeta[]): Promise<FormInstanceResponseBeta[]> {
    //     let formInstances = await this.client.listFormInstances()
    //     //Order from older to newer
    //     formInstances = formInstances.sort((a, b) => new Date(a.modified!).valueOf() - new Date(b.modified!).valueOf())

    //     if (forms) {
    //         const formIDs = forms.map((x) => x.id)
    //         const currentFormInstances = formInstances.filter((x) => formIDs.includes(x.formDefinitionId))
    //         return currentFormInstances
    //     } else {
    //         return formInstances
    //     }
    // }

    // async getUniqueFormInstances(forms?: FormDefinitionResponseBeta[]): Promise<FormInstanceResponseBeta[]> {
    //     let formInstances = await this.client.listFormInstances()
    //     //Order from older to newer
    //     formInstances = formInstances.sort((a, b) => new Date(a.modified!).valueOf() - new Date(b.modified!).valueOf())

    //     if (forms) {
    //         const formIDs = forms.map((x) => x.id)
    //         const currentFormInstances = formInstances.filter((x) => formIDs.includes(x.formDefinitionId))
    //         return currentFormInstances
    //     } else {
    //         return formInstances
    //     }
    // }

    async deleteUniqueFormInstance(formInstance: FormInstanceResponseBeta) {
        const index = this.uniqueFormInstances.findIndex((x) => x.id === formInstance.id)
        if (index) {
            this.uniqueFormInstances.splice(index, 1)
        }
    }

    async createUniqueFormInstance(form: FormDefinitionResponseBeta, reviewerID: string) {
        const expire = getExpirationDate(this.config)
        const formInput = form.formInput?.reduce(getInputFromDescription, {})

        const currentFormInstance = await this.client.createFormInstance(
            form.id!,
            formInput!,
            [reviewerID],
            this.source!.id!,
            expire
        )
        this.uniqueFormInstances.push(currentFormInstance)

        return currentFormInstance
    }

    async createEditFormInstance(form: FormDefinitionResponseBeta, reviewerID: string) {
        const expire = getExpirationDate(this.config)
        const formInput = form.formInput?.reduce(getInputFromDescription, {})

        const currentFormInstance = await this.client.createFormInstance(
            form.id!,
            formInput!,
            [reviewerID],
            this.source!.id!,
            expire
        )
        this.editFormInstances.push(currentFormInstance)

        return currentFormInstance
    }

    async isMergingEnabled(): Promise<boolean> {
        return this.config.merging_isEnabled && this.listAllReviewerIDs().length > 0
    }

    private findIdenticalMatch(account: Account): IdentityDocument | undefined {
        let match: IdentityDocument | undefined
        const accountAttributes = buildAccountAttributesObject(account, this.config.merging_map, true)
        const accountStringAttributes = JSON.stringify(accountAttributes)
        const candidatesAttributes = this.currentIdentities.map((x) =>
            buildIdentityAttributesObject(x, this.config.merging_map)
        )
        const candidatesStringAttributes = candidatesAttributes.map((x) => JSON.stringify(x))

        const firstIndex = candidatesStringAttributes.indexOf(accountStringAttributes)
        if (firstIndex > -1) {
            match = this.currentIdentities[firstIndex]
        }

        return match
    }

    private findSimilarMatches(account: Account): { identity: IdentityDocument; score: Map<string, string> }[] {
        const similarMatches: { identity: IdentityDocument; score: Map<string, string> }[] = []
        const accountAttributes = buildAccountAttributesObject(account, this.config.merging_map, true)
        const length = Object.keys(accountAttributes).length

        candidates: for (const candidate of this.currentIdentities) {
            // const scores: number[] = []
            const scores = new Map<string, number>()
            attributes: for (const attribute of Object.keys(accountAttributes)) {
                const iValue = accountAttributes[attribute] as string
                const cValue = candidate.attributes![attribute] as string
                if (iValue && cValue) {
                    const similarity = lig3(iValue, cValue)
                    const score = similarity * 100
                    if (!this.config.global_merging_score) {
                        const threshold = this.config.getScore(attribute)
                        if (score < threshold) {
                            continue candidates
                        }
                    }
                    scores.set(attribute, score)
                }
            }

            if (this.config.global_merging_score) {
                const finalScore =
                    [...scores.values()].reduce((p, c) => {
                        return p + c
                    }, 0) / length

                if (finalScore >= this.config.getScore()) {
                    const score = new Map<string, string>()
                    score.set('overall', finalScore.toFixed(0))
                    similarMatches.push({ identity: candidate, score })
                }
            } else {
                const score = new Map<string, string>()
                scores.forEach((v, k) => score.set(k, v.toFixed(0)))
                similarMatches.push({ identity: candidate, score })
            }
        }

        return similarMatches
    }

    async analyzeUncorrelatedAccount(uncorrelatedAccount: Account): Promise<AccountAnalysis> {
        const c = 'analyzeUncorrelatedAccount'

        let results: string[] = []
        const normalizedAccount = normalizeAccountAttributes(uncorrelatedAccount, this.config.merging_map)
        const identicalMatch = this.findIdenticalMatch(normalizedAccount)
        let similarMatches: SimilarAccountMatch[] = []
        if (identicalMatch) {
            logger.debug(
                lm(`Checking identical match for ${uncorrelatedAccount.name} (${uncorrelatedAccount.id}).`, c, 1)
            )
            results.push(`Identical to ${stringifyIdentity(identicalMatch, this.baseUrl)}`)
            logger.debug(lm(`Identical match found.`, c, 1))
            // Check if similar match exists
        } else {
            logger.debug(
                lm(`Checking similar matches for ${uncorrelatedAccount.name} (${uncorrelatedAccount.id})`, c, 1)
            )

            similarMatches = this.findSimilarMatches(uncorrelatedAccount)
            if (similarMatches.length > 0) {
                results = results.concat(
                    similarMatches.map(
                        (x) =>
                            `Similar to ${stringifyIdentity(x.identity, this.baseUrl)} [ ${stringifyScore(x.score)} ]`
                    )
                )
                logger.debug(lm(`Similar matches found`, c, 1))
            } else {
                results.push(`No matching identity found`)
            }
        }

        const analysis: AccountAnalysis = {
            account: normalizedAccount,
            results,
            identicalMatch,
            similarMatches,
        }

        return analysis
    }

    async processUncorrelatedAccount(uncorrelatedAccount: Account): Promise<UniqueForm | undefined> {
        const c = 'processUncorrelatedAccount'

        let account: Account | undefined
        let uniqueAccount: Account | undefined
        let uniqueForm: UniqueForm | undefined
        let status
        let message = ''

        if (this.mergingEnabled) {
            const { identicalMatch, similarMatches } = await this.analyzeUncorrelatedAccount(uncorrelatedAccount)

            if (identicalMatch) {
                logger.debug(lm(`Identical match found.`, c, 1))
                uniqueAccount = this.accounts.find((x) => x.identityId === identicalMatch.id) as Account
                uniqueAccount.modified = new Date(0).toISOString()
                message = datedMessage('Identical match found.', uncorrelatedAccount)
                status = 'auto'
                const attributes = uniqueAccount.attributes!
                attributes.statuses.push(status)
                attributes.accounts.push(uncorrelatedAccount.id)
                attributes.history.push(message)
                deleteArrayItem(attributes.statuses, 'edited')
                // Check if similar match exists
            } else {
                if (similarMatches.length > 0) {
                    logger.debug(lm(`Similar matches found`, c, 1))
                    const formName = this.getUniqueFormName(uncorrelatedAccount, this.source!.name)
                    const formOwner = { id: this.source!.owner.id, type: this.source!.owner.type }
                    const accountAttributes = buildAccountAttributesObject(
                        uncorrelatedAccount,
                        this.config.merging_map,
                        true
                    )
                    uncorrelatedAccount.attributes = { ...uncorrelatedAccount.attributes, ...accountAttributes }
                    uncorrelatedAccount = normalizeAccountAttributes(uncorrelatedAccount, this.config.merging_map)
                    uniqueForm = new UniqueForm(
                        formName,
                        formOwner,
                        uncorrelatedAccount,
                        similarMatches,
                        this.config.merging_attributes,
                        this.config.getScore
                    )
                } else {
                    // No matching existing identity found
                    logger.debug(lm(`No matching identity found. Creating new unique account.`, c, 1))
                    message = `No matching identity found`
                    status = 'unmatched'
                    account = uncorrelatedAccount
                }
            }
        } else {
            logger.debug(lm(`Skipping merging for ${uncorrelatedAccount.name} (${uncorrelatedAccount.id}).`, c, 1))
            message = `Identity merging not activated`
            status = 'unmatched'
            account = uncorrelatedAccount
        }

        if (account) {
            uniqueAccount = await this.buildUniqueAccount(account, status!, message)
        }

        return uniqueForm
    }

    async sendEmail(email: ReviewEmail) {
        await this.client.testWorkflow(this.emailer!.id!, email)
    }

    loadSchema(schema: AccountSchema) {
        this.schema = schema
    }

    async getSchema(): Promise<AccountSchema> {
        let schema: AccountSchema
        if (this.schema) {
            schema = this.schema
        } else {
            schema = await this.buildDynamicSchema()
        }

        return schema
    }

    getEmailer(): WorkflowBeta {
        return this.emailer!
    }

    async fetchUniqueIDs() {
        if (this.config.uid_scope === 'source') {
            logger.info('Compiling current IDs for source scope.')
            this.ids = this.accounts.map((x) => x.attributes!.uniqueID)
        } else {
            logger.info('Compiling current IDs for tenant scope.')
            this.ids = this.identities.map((x) => x.attributes!.uid)
        }
    }

    private async getEmailWorkflow(name: string, owner: OwnerDto): Promise<WorkflowBeta | undefined> {
        const c = 'getEmailWorkflow'
        logger.debug(lm('Fetching workflows', c, 1))
        const workflows = await this.client.listWorkflows()
        let workflow = workflows.find((x) => x.name === name)
        if (workflow) {
            logger.debug(lm('Workflow found', c, 1))
        } else {
            logger.debug(lm('Creating workflow', c, 1))
            const emailWorkflow = new EmailWorkflow(name, owner)
            workflow = await this.client.createWorkflow(emailWorkflow)
        }

        if (!workflow) throw new Error('Unable to instantiate email workflow')

        return workflow
    }

    isSourceReviewer(sourceName: string, identityID: string): boolean {
        return this.reviewerIDs.get(sourceName)!.includes(identityID)
    }

    private async buildReviewersMap(): Promise<Map<string, string[]>> {
        const reviewersMap = new Map<string, string[]>()

        if (this.initiated === 'full') {
            const allReviewers = this.accounts.filter((x) => x.attributes!.statuses.includes('reviewer'))
            for (const source of this.sources) {
                const sourceID = source.id!
                const reviewers = allReviewers.filter((x) => x.attributes!.actions.includes(sourceID))
                const reviewerIDs = reviewers.map((x) => x.identityId!)
                reviewersMap.set(source.name, reviewerIDs)
            }
        } else {
            const reviewerIdentities = await this.client.listIdentitiesByEntitlements(['reviewer'])
            const hasReviewerEntitlement = (access: IdentityAccess, sourceId: string) => {
                if (access.type === 'ENTITLEMENT') {
                    const entitlement = access as AccessProfileEntitlement
                    return entitlement.value === sourceId && entitlement.source!.id === this.source!.id
                }

                return false
            }
            for (const source of this.sources) {
                const reviewerIDs = reviewerIdentities
                    .filter((x) => x.access!.some((x) => hasReviewerEntitlement(x, source.id!)))
                    .map((x) => x.id)
                reviewersMap.set(source.name, reviewerIDs)
            }
        }

        return reviewersMap
    }

    // private async fetchReviewerIDs(source: Source): Promise<string[]> {
    //     const c = 'fetchReviewerIDs'
    //     logger.debug(lm(`Fetching reviewers for ${source.name}`, c, 1))
    //     let reviewers: string[] = []

    //     if (source.managementWorkgroup) {
    //         logger.debug(lm(`Reviewer is ${source.managementWorkgroup.name} workgroup`, c, 1))
    //         const workgroups = await this.client.listWorkgroups()
    //         const workgroup = workgroups.find((x) => x.id === source.managementWorkgroup!.id)
    //         if (workgroup) {
    //             logger.debug(lm('Workgroup found', c, 1))
    //             const members = await this.client.listWorkgroupMembers(workgroup.id!)
    //             reviewers = members.map((x) => x.id!)
    //         }
    //     } else if (source.owner || reviewers.length === 0) {
    //         logger.debug(lm('Reviewer is the owner', c, 1))
    //         const reviewerIdentity = await this.client.getIdentity(source.owner.id!)
    //         if (reviewerIdentity) {
    //             logger.debug(lm('Reviewer found', c, 1))
    //             reviewers.push(reviewerIdentity.id!)
    //         } else {
    //             logger.error(lm(`Reviewer not found ${source.owner.name}`, c, 1))
    //         }
    //     } else {
    //         logger.warn(lm(`No reviewer provided. Merging forms will not be processed.`, c, 1))
    //     }

    //     return reviewers
    // }

    async processUniqueFormInstance(
        formInstance: FormInstanceResponseBeta
    ): Promise<{ decision: string; account: string; message: string }> {
        const c = 'processUniqueFormInstance'
        let message = ''
        const decision = formInstance.formData!['identities'].toString()
        const account = (formInstance.formInput!['account'] as any).value
        const reviewerIdentity = await this.client.getIdentityBySearch(formInstance.recipients![0].id!)
        const reviewerName = reviewerIdentity
            ? reviewerIdentity.displayName
                ? reviewerIdentity.displayName
                : reviewerIdentity.name
            : formInstance.recipients![0].id!

        if (decision === 'This is a new identity') {
            message = `New identity approved by ${reviewerName}`
        } else {
            message = `Assignment approved by ${reviewerName}`
        }

        return { decision, account, message }
    }

    async resetUniqueID(account: UniqueAccount): Promise<UniqueAccount> {
        const uniqueID = await this.buildUniqueID(account.identity)
        account.attributes!.uniqueID = uniqueID
        const schema = await this.getSchema()
        if (schema) {
            account.identity = (
                account.attributes[schema.identityAttribute]
                    ? account.attributes[schema.identityAttribute]
                    : account.attributes.uuid
            ) as string
            account.uuid = (
                account.attributes[schema.displayAttribute]
                    ? (account.attributes[schema.displayAttribute] as string)
                    : account.attributes.uuid
            ) as string
        } else {
            account.identity = account.attributes.uuid as string
            account.uuid = account.attributes.uuid as string
        }

        return account
    }

    private async buildDynamicSchema(): Promise<AccountSchema> {
        const c = 'buildDynamicSchema'
        logger.debug(lm('Fetching sources.', c, 1))
        const schemas: Schema[] = []
        logger.debug(lm('Fetching schemas.', c, 1))
        for (const source of this.sources) {
            const sourceSchemas = await this.client.listSourceSchemas(source.id!)
            schemas.push(sourceSchemas.find((x) => x.name === 'account') as Schema)
        }

        logger.debug(lm('Compiling attributes.', c, 1))
        const combinedAttributes: Map<string, AttributeDefinition> = new Map()
        for (const schema of schemas.reverse()) {
            schema.attributes?.forEach((x) => combinedAttributes.set(x.name!, x))
        }

        logger.debug(lm('Defining static attributes.', c, 1))
        const attributes: SchemaAttribute[] = [
            {
                name: 'uniqueID',
                description: 'Unique ID',
                type: 'string',
                required: true,
            },
            {
                name: 'uuid',
                description: 'UUID',
                type: 'string',
                required: true,
            },
            {
                name: 'history',
                description: 'History',
                type: 'string',
                multi: true,
            },
            {
                name: 'statuses',
                description: 'Statuses',
                type: 'string',
                multi: true,
                entitlement: true,
                managed: false,
                schemaObjectType: 'status',
            },
            {
                name: 'actions',
                description: 'Actions',
                type: 'string',
                multi: true,
                entitlement: true,
                managed: true,
                schemaObjectType: 'action',
            },
            {
                name: 'accounts',
                description: 'Account IDs',
                type: 'string',
                multi: true,
                entitlement: false,
            },
            {
                name: 'reviews',
                description: 'Reviews',
                type: 'string',
                multi: true,
                entitlement: false,
            },
        ]

        logger.debug(lm('Processing attribute merge mapping.', c, 1))
        for (const mergingConf of this.config.merging_map) {
            const description = mergingConf.source ? mergingConf.source : mergingConf.identity
            const attribute: any = {
                name: mergingConf.identity,
                description,
                type: 'string',
            }

            switch (mergingConf.attributeMerge) {
                case 'multi':
                    attribute.multi = true
                    attribute.entitlement = true
                    break

                case 'concatenate':
                    attribute.multi = false
                    break

                default:
                    break
            }

            attributes.push(attribute)
        }

        logger.debug(lm('Processing existing attributes.', c, 1))
        for (const attribute of combinedAttributes.values()) {
            if (!attributes.find((x) => x.name === attribute.name!)) {
                const mergingConf = this.config.merging_map.find((x) => x.attributeMerge?.includes(attribute.name!))
                let attributeMerge: string
                if (mergingConf?.attributeMerge) {
                    attributeMerge = mergingConf.attributeMerge
                } else {
                    attributeMerge = this.config.attributeMerge
                }
                const matchingSchemas = schemas.filter((x) => x.attributes?.find((y) => y.name === attribute.name))
                switch (attributeMerge) {
                    case 'multi':
                        if (matchingSchemas.length > 1) {
                            attribute.isMulti = true
                            attribute.type = 'STRING'
                        }
                        break

                    case 'concatenate':
                        attribute.isMulti = false
                        attribute.type = 'STRING'
                        break

                    default:
                        break
                }

                if (attribute.isMulti) {
                    attribute.isEntitlement = true
                    attribute.isGroup = false
                }

                const description = (
                    attribute.description === null || attribute.description === ''
                        ? attribute.name
                        : attribute.description
                ) as string
                const schemaAttribute: SchemaAttribute = {
                    name: attribute.name!,
                    description,
                    type: attribute.type ? attribute.type.toLowerCase() : 'string',
                    multi: attribute.isMulti,
                    managed: false,
                    entitlement: attribute.isEntitlement,
                }

                attributes.push(schemaAttribute)
            }
        }

        const schema: any = {
            attributes,
            displayAttribute: 'uuid',
            identityAttribute: 'uuid',
        }

        return schema
    }

    processReviewFormInstanceEdits(formInstance: FormInstanceResponseBeta, account: Account): boolean {
        let edited = false
        for (const attribute of this.config.merging_attributes) {
            if (formInstance.formData![attribute] !== account.attributes![attribute]) {
                account.attributes![attribute] = formInstance.formData![attribute]
                edited = true
            }
        }

        return edited
    }

    processEditFormInstanceEdits(formInstance: FormInstanceResponseBeta, account: Account) {
        const regex = /\d+\.(.+)/
        for (const attribute of Object.keys(formInstance.formData!)) {
            const result = regex.exec(attribute)
            if (result) {
                const id = result[1]
                account.attributes![id] = formInstance.formData![attribute]
            }
        }
    }

    buildStatusEntitlements(): Status[] {
        const statusEntitlements = statuses.map((x) => new Status(x))

        return statusEntitlements
    }

    buildActionEntitlements(): Action[] {
        const actionEntitlements = actions.map((x) => new Action(x))
        const sourceInput: ActionSource[] = this.sources.map(({ id, name }) => ({
            id: id!,
            name: `${name} reviewer`,
            description: `Reviewer for source ${name} potentially duplicated identities`,
        }))
        const sourceEntitlements = sourceInput.map((x) => new Action(x))
        const entitlements = [...actionEntitlements, ...sourceEntitlements]

        return entitlements
    }

    handleError(error: any) {
        let message = error
        if (error instanceof Error) {
            message = error.message
            if (error instanceof AxiosError) {
                const details = error.response!.data.messages.find((x: { locale: string }) => x.locale === 'en-US')
                if (details) {
                    message = message + '\n' + details.text
                }
            }
        }
        logger.error(message)
        logger.error(error)
        this.errors.push(message)
    }

    async logErrors(context: Context, input: any) {
        if (this.errors.length > 0) {
            const message = composeErrorMessage(context, input, this.errors)

            const ownerID = this.getSource().owner.id as string
            const recipient = await this.client.getIdentityBySearch(ownerID)
            const email = new ErrorEmail(this.getSource(), recipient!.email!, message)

            await this.sendEmail(email)
        }
    }
}
