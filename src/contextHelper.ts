import {
    Account,
    AttributeDefinition,
    BaseAccount,
    FormDefinitionResponseBeta,
    FormInstanceResponseBeta,
    IdentityBeta,
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
    combineArrays,
    composeErrorMessage,
    datedMessage,
    getExpirationDate,
    getFormName,
    getInputFromDescription,
    getOwnerFromSource,
    lm,
    md,
    processUncorrelatedAccount,
    sleep,
    updateAccountLinks,
} from './utils'
import { IDENTITYNOTFOUNDRETRIES, IDENTITYNOTFOUNDWAIT, WORKFLOW_NAME, reservedAttributes } from './constants'
import { UniqueForm } from './model/form'
import { buildUniqueID } from './utils/unique'
import { Email, ErrorEmail } from './model/email'
import { UniqueAccount } from './model/account'
import { AxiosError } from 'axios'
import { v4 as uuidv4 } from 'uuid'
import { EmailWorkflow } from './model/emailWorkflow'

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
    private forms: FormDefinitionResponseBeta[]
    private formInstances: FormInstanceResponseBeta[]
    private errors: string[]

    constructor(config: Config) {
        this.config = config
        this.sources = []
        this.ids = []
        this.identities = []
        this.currentIdentities = []
        this.accounts = []
        this.authoritativeAccounts = []
        this.forms = []
        this.formInstances = []
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
    }

    async init(skipData?: boolean) {
        logger.debug(lm(`Looking for connector instance`, this.c))
        const id = this.config?.spConnectorInstanceId as string
        const allSources = await this.client.listSources()
        this.source = allSources.find((x) => (x.connectorAttributes as any).spConnectorInstanceId === id)
        this.sources = allSources.filter((x) => this.config?.sources.includes(x.name))

        if (!this.source) {
            throw new ConnectorError('No connector source was found on the tenant.')
        }

        const owner = getOwnerFromSource(this.source)
        const wfName = `${WORKFLOW_NAME} (${this.config!.cloudDisplayName})`
        this.emailer = await this.getEmailWorkflow(wfName, owner)

        this.reviewerIDs = await this.buildReviewersMap()

        if (!skipData) {
            this.identities = await this.listIdentities()
            this.accounts = await this.listAccounts()
            const identityIDs = this.accounts.map((x) => x.identityId)
            this.authoritativeAccounts = await this.listAuthoritativeAccounts()
            this.currentIdentities = this.identities.filter((x) => identityIDs.includes(x.id))
            this.forms = await this.listForms()
            this.formInstances = await this.getFormInstances(this.forms)

            if (this.config.uid_scope === 'source') {
                logger.info('Compiling current IDs for source scope.')
                this.ids = this.accounts.map((x) => x.attributes!.uniqueID)
            } else {
                logger.info('Compiling current IDs for tenant scope.')
                this.ids = this.identities.map((x) => x.attributes!.uid)
            }
        } else {
            this.identities = []
            this.accounts = []
            this.authoritativeAccounts = []
            this.currentIdentities = []
            this.forms = []
            this.formInstances = []
        }
        this.errors = []
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

    listReviewerIDs(source: string): string[] {
        return this.reviewerIDs.get(source) || []
    }

    listAllReviewerIDs(): string[] {
        const ids = Array.from(this.reviewerIDs.values()).flat()

        return Array.from(new Set(ids))
    }

    deleteReviewerID(reviewerID: string, sourceName: string) {
        const reviewers = this.reviewerIDs.get(sourceName)
        if (reviewers) {
            reviewers.splice(reviewers.indexOf(reviewerID), 1)
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

    getIdentityById(id: string): IdentityDocument | undefined {
        return this.identities.find((x) => x.id === id)
    }

    getIdentityByUID(uid: string): IdentityDocument | undefined {
        return this.identities.find((x) => x.attributes!.uid === uid)
    }

    private async listAccounts(): Promise<Account[]> {
        const c = 'listAccounts'
        const source = this.getSource()

        logger.info(lm('Fetching existing accounts.', c))
        let accounts = await this.client.listAccountsBySource(source.id!)
        accounts = accounts || []

        logger.debug(lm('Updating existing account links.', c))
        for (const account of accounts) {
            // updateAccountLinks(account, this.identities, config.sources)
            account.attributes!.accounts = account.attributes!.accounts || []
            account.attributes!.status = account.attributes!.status || []
            account.attributes!.reviews = account.attributes!.reviews || []
            account.attributes!.history = account.attributes!.history || []
        }
        // if (this.config?.deleteEmpty) {
        //     accounts = accounts.filter(
        //         (x) =>
        //             !(
        //                 x.uncorrelated === false &&
        //                 x.attributes.accounts.length === 0 &&
        //                 !x.attributes.status.includes('reviewer')
        //             )
        //     )
        // }

        return accounts
    }

    listProcessedAccountIDs(): string[] {
        return this.accounts.map((x) => x.attributes!.accounts).flat()
    }

    async getAccount(id: string): Promise<Account | undefined> {
        const account = await this.client.getAccount(id)

        return account
    }

    getAccountByIdentity(identity: IdentityDocument): Account | undefined {
        return this.accounts.find((x) => x.identityId === identity.id)
    }

    getIdentityAccount(identity: IdentityDocument): Account | undefined {
        return this.accounts.find((x) => x.identityId === identity.id)
    }

    listCurrentIdentityIDs(): string[] {
        return this.accounts.map((x) => x.identityId!)
    }

    async listAuthoritativeAccounts(): Promise<Account[]> {
        const c = 'listAuthoritativeAccounts'

        logger.info(lm('Fetching authoritative accounts.', c))
        const authoritativeAccounts = await this.client.listAccounts(this.sources.map((x) => x.id!))

        return authoritativeAccounts
    }

    async *listUniqueAccounts(): AsyncGenerator<UniqueAccount> {
        const c = 'listUniqueAccounts'
        const accounts: UniqueAccount[] = []
        const uuids: string[] = []

        if (this.config.deleteEmpty) {
            this.accounts = this.accounts.filter(
                (x) =>
                    !(
                        x.uncorrelated === false &&
                        x.attributes!.accounts.length === 0 &&
                        !x.attributes!.status.includes('reviewer')
                    )
            )
        }

        logger.debug(lm('Updating accounts.', c))
        for (const account of this.accounts) {
            updateAccountLinks(account, this.identities, this.config.sources)

            while (!account.attributes!.uuid) {
                const uuid = uuidv4()
                if (!uuids.includes(uuid)) {
                    uuids.push(uuid)
                    account.attributes!.uuid = uuid
                    uuids.push(uuid)
                }
            }

            const uniqueAccount = await this.refreshUniqueAccount(account)
            if (uniqueAccount) {
                yield uniqueAccount
            }
        }
    }

    async refreshUniqueAccount(account: Account): Promise<UniqueAccount | undefined> {
        const c = 'refreshUniqueAccount'

        let sourceAccounts: Account[] = []
        for (const sourceName of this.config.sources) {
            const accounts = this.authoritativeAccounts.filter(
                (x) => x.sourceName === sourceName && account.attributes!.accounts.includes(x.id)
            )
            sourceAccounts = sourceAccounts.concat(accounts)
        }

        const lastConfigChange = new Date(this.source!.modified!).getTime()
        const lastModified = new Date(account.modified!).getTime()
        const newSourceData = sourceAccounts.find((x) => new Date(x.modified!).getTime() > lastModified) ? true : false
        const needsRefresh = newSourceData || lastModified < lastConfigChange

        if (sourceAccounts.length === 0) sourceAccounts.push(account)

        try {
            const schema = await this.getSchema()
            const attributes = account.attributes
            if (needsRefresh) {
                logger.debug(lm(`Refreshing ${account.attributes!.uniqueID} account`, c, 1))

                for (const attrDef of schema.attributes) {
                    if (!reservedAttributes.includes(attrDef.name)) {
                        const attrConf = this.config.merging_map.find((x) => x.identity === attrDef.name)
                        const attributeMerge = attrConf?.attributeMerge || this.config.attributeMerge
                        let firstSource = true
                        for (const sourceAccount of sourceAccounts) {
                            let value: any
                            if (attrConf) {
                                for (const accountAttr of attrConf.account) {
                                    if (!sourceAccount.attributes) logger.warn(sourceAccount)
                                    value = sourceAccount.attributes![accountAttr]
                                    if (value) break
                                }
                            } else {
                                value = sourceAccount.attributes![attrDef.name]
                            }
                            if (value) {
                                let lst: string[]
                                switch (attributeMerge) {
                                    case 'multi':
                                        if (firstSource) {
                                            lst = [].concat(value)
                                        } else {
                                            let previousList: string[] = [].concat(attributes![attrDef.name])
                                            if (previousList.length === 0) {
                                                lst = [].concat(value)
                                            } else if (previousList.length > 1) {
                                                lst = [...previousList, value]
                                            } else {
                                                lst = [...attrSplit(previousList[0]), value]
                                            }
                                        }
                                        attributes![attrDef.name] = Array.from(new Set(lst))
                                        break

                                    case 'concatenate':
                                        if (firstSource) {
                                            lst = [].concat(value)
                                        } else {
                                            lst = []
                                            let previousList: string[] = [].concat(attributes![attrDef.name])
                                            for (const item of previousList) {
                                                lst = lst.concat(attrSplit(item))
                                            }
                                            lst = lst.concat(attrSplit(value))
                                        }
                                        attributes![attrDef.name] = attrConcat(lst)
                                        break
                                    case 'first':
                                        if (firstSource) {
                                            attributes![attrDef.name] = value
                                        }
                                        break

                                    case 'source':
                                        const source = attrConf?.source
                                        if (sourceAccount.sourceName === source) {
                                            attributes![attrDef.name] = value
                                        }
                                        break
                                    default:
                                        break
                                }
                            }
                            firstSource = false
                        }
                    }
                }
            }

            attributes!.status = Array.from(new Set(attributes!.status))

            if (account.uncorrelated) {
                logger.debug(lm(`New account. Needs to be enabled.`, c, 2))
            } else {
                logger.debug(lm(`Existing account. Enforcing defined correlation.`, c, 1))
                let identity: IdentityDocument | IdentityBeta | undefined
                let accounts: Account[] | BaseAccount[]
                identity = this.identities.find((x) => x.id === account.identityId) as IdentityDocument
                if (!identity) {
                    let count = 0
                    let wait = IDENTITYNOTFOUNDWAIT
                    while (!identity) {
                        identity = await this.client.getIdentity(account.identityId!)
                        if (!identity) {
                            if (++count > IDENTITYNOTFOUNDRETRIES)
                                throw new Error(
                                    `Identity ${account.identityId} for account ${account.nativeIdentity} not found`
                                )

                            logger.warn(lm(`Identity ID ${account.identityId} not found. Re-trying...`, c, 1))
                            await sleep(wait)
                            wait = wait + IDENTITYNOTFOUNDWAIT
                        }
                    }
                    accounts = await this.client.getAccountsByIdentity(identity!.id!)
                } else {
                    accounts = (identity as IdentityDocument).accounts!
                }

                for (const acc of account.attributes!.accounts as string[]) {
                    const uid: string = (identity.attributes as any).uid
                    try {
                        if (!accounts.find((x) => x.id === acc)) {
                            logger.debug(lm(`Correlating ${acc} account with ${uid}.`, c, 1))
                            const response = await this.client.correlateAccount(identity.id as string, acc)
                        }
                    } catch (e) {
                        logger.error(lm(`Failed to correlate ${acc} account with ${uid}.`, c, 1))
                        account.attributes!.accounts = account.attributes!.accounts.filter((x: string) => x !== acc)
                    }
                }
            }

            const uniqueAccount = new UniqueAccount(account, schema)

            return uniqueAccount
        } catch (error) {
            logger.error(error as string)
        }
    }

    async buildUniqueAccount(account: Account, status: string, msg: string): Promise<Account> {
        const c = 'buildUniqueAccount'
        logger.debug(lm(`Processing ${account.name} (${account.id})`, c, 1))
        let uniqueID: string

        uniqueID = await buildUniqueID(account, this.ids, this.config)

        const uniqueAccount: Account = { ...account }

        if (status !== 'reviewer') {
            uniqueID = await buildUniqueID(account, this.ids, this.config)
            uniqueAccount.attributes!.accounts = [account.id]
        } else {
            uniqueAccount.attributes!.accounts = []
            logger.debug(lm(`Taking identity uid as unique ID`, c, 1))
            const identity = this.identities.find((x) => x.id === account.identityId) as IdentityDocument
            uniqueID = identity?.attributes!.uid
        }

        uniqueAccount.attributes!.uniqueID = uniqueID
        uniqueAccount.attributes!.status = [status]
        uniqueAccount.attributes!.reviews = []

        if (msg) {
            const message = datedMessage(msg, account)
            uniqueAccount.attributes!.history = [message]
        }

        this.ids.push(uniqueAccount.attributes!.uniqueID)
        this.accounts.push(uniqueAccount)

        return uniqueAccount
    }

    async buildUniqueAccountFromID(id: string): Promise<UniqueAccount> {
        const schema = await this.getSchema()

        const c = 'buildUniqueAccountFromID'
        logger.debug(lm(`Fetching original account`, c, 1))
        const account = await this.client.getAccountBySourceAndNativeIdentity(this.getSource().id!, id)
        const sourceAccounts: Account[] = []
        if (account) {
            const identity = await this.client.getIdentity(account.identityId!)
            const accounts = await this.client.getAccountsByIdentity(identity!.id!)
            const correlatedAccounts = accounts
                .filter((x) => this.config.sources.includes(x.sourceName!))
                .map((x) => x.id as string)
            account.attributes!.accounts = combineArrays(correlatedAccounts, account.attributes!.accounts)

            for (const acc of account.attributes!.accounts) {
                logger.debug(lm(`Looking for ${acc} account`, c, 1))
                const response = await this.client.getAccount(acc)
                if (response) {
                    logger.debug(lm(`Found linked account ${response.name} (${response.sourceName})`, c, 1))
                    sourceAccounts.push(response)
                } else {
                    logger.error(lm(`Unable to find account ID ${acc}`, c, 1))
                }
            }

            const uniqueAccount = await this.refreshUniqueAccount(account)
            return uniqueAccount!
        } else {
            throw new ConnectorError('Account not found', ConnectorErrorType.NotFound)
        }
    }

    async buildUniqueID(id: string): Promise<string> {
        const account = await this.client.getAccountBySourceAndNativeIdentity(this.source!.id!, id)
        const uniqueID = await buildUniqueID(account!, this.ids, this.config)
        this.ids.push(uniqueID)

        return uniqueID
    }

    addForm(form: FormDefinitionResponseBeta) {
        this.forms.push(form)
    }

    getFormName(account?: Account): string {
        return getFormName(this.getSource().name, account)
    }

    listFormInstancesByForm(form: FormDefinitionResponseBeta): FormInstanceResponseBeta[] {
        return this.formInstances.filter((x) => x.formDefinitionId === form.id)
    }

    listFormInstancesByReviewerID(reviewerID: string): FormInstanceResponseBeta[] {
        return this.formInstances.filter((x) => x.recipients!.find((y) => y.id === reviewerID))
    }

    getFormByID(id: string): FormDefinitionResponseBeta | undefined {
        return this.forms.find((x) => x.id === id)
    }

    getFormInstanceByReviewerID(
        form: FormDefinitionResponseBeta,
        reviewerID: string
    ): FormInstanceResponseBeta | undefined {
        return this.formInstances.find(
            (x) => x.formDefinitionId === form.id && x.recipients!.find((y) => y.id === reviewerID)
        )
    }

    async listForms(): Promise<FormDefinitionResponseBeta[]> {
        const forms = await this.client.listForms()
        const currentForms = forms.filter((x) => x.name?.startsWith(this.getFormName()))

        return currentForms
    }

    async createUniqueForm(form: UniqueForm): Promise<FormDefinitionResponseBeta> {
        const response = await this.client.createForm(form)
        this.forms.push(response)

        return response
    }

    async deleteForm(form: FormDefinitionResponseBeta) {
        await this.client.deleteForm(form.id!)

        const index = this.forms.findIndex((x) => x.id === form.id!)
        this.forms.splice(index, 1)
    }

    async getFormInstances(forms?: FormDefinitionResponseBeta[]): Promise<FormInstanceResponseBeta[]> {
        let formInstances = await this.client.listFormInstances()
        //Order from older to newer
        formInstances = formInstances.sort((a, b) => new Date(a.modified!).valueOf() - new Date(b.modified!).valueOf())

        if (forms) {
            const formIDs = forms.map((x) => x.id)
            const currentFormInstances = formInstances.filter((x) => formIDs.includes(x.formDefinitionId))
            return currentFormInstances
        } else {
            return formInstances
        }
    }

    async deleteFormInstance(formInstance: FormInstanceResponseBeta) {
        this.formInstances.splice(this.formInstances.indexOf(formInstance), 1)
    }

    // async processFormInstance(
    //     formInstance: FormInstanceResponseBeta
    // ): Promise<{ decision: string; account: string; message: string }> {
    //     return processFormInstance(this.client, formInstance)
    // }

    async createFormInstance(form: FormDefinitionResponseBeta, reviewerID: string) {
        const expire = getExpirationDate(this.config)
        const formInput = form.formInput?.reduce(getInputFromDescription, {})

        const currentFormInstance = await this.client.createFormInstance(
            form.id!,
            formInput!,
            [reviewerID],
            this.source!.id!,
            expire
        )
        this.formInstances.push(currentFormInstance)

        return currentFormInstance
    }

    async isMergingEnabled(): Promise<boolean> {
        return this.config.merging_isEnabled === true && this.listAllReviewerIDs().length > 0
    }

    async processUncorrelatedAccount(
        uncorrelatedAccount: Account
    ): Promise<{ processedAccount: Account | undefined; uniqueForm: UniqueForm | undefined }> {
        const deduplicate = await this.isMergingEnabled()

        const response = await processUncorrelatedAccount(
            uncorrelatedAccount,
            this.accounts,
            this.currentIdentities,
            this.source!,
            this.config,
            deduplicate
        )

        return response
    }

    async sendEmail(email: Email) {
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

    private async buildReviewersMap(): Promise<Map<string, string[]>> {
        const reviewersMap = new Map<string, string[]>()
        let defaultReviewerIDs: string[] = []
        if (!this.config.merging_reviewerIsSourceOwner) {
            defaultReviewerIDs = await this.fetchReviewerIDs(this.source!)
        }

        for (const source of this.sources) {
            if (this.config.merging_reviewerIsSourceOwner) {
                const reviewerIDs = await this.fetchReviewerIDs(source)
                reviewersMap.set(source.name, reviewerIDs)
            } else {
                reviewersMap.set(source.name, defaultReviewerIDs)
            }
        }

        return reviewersMap
    }

    private async fetchReviewerIDs(source: Source): Promise<string[]> {
        const c = 'fetchReviewerIDs'
        logger.debug(lm(`Fetching reviewers for ${source.name}`, c, 1))
        let reviewers: string[] = []

        if (source.managementWorkgroup) {
            logger.debug(lm(`Reviewer is ${source.managementWorkgroup.name} workgroup`, c, 1))
            const workgroups = await this.client.listWorkgroups()
            const workgroup = workgroups.find((x) => x.id === source.managementWorkgroup!.id)
            if (workgroup) {
                logger.debug(lm('Workgroup found', c, 1))
                const members = await this.client.listWorkgroupMembers(workgroup.id!)
                reviewers = members.map((x) => x.id!)
            }
        } else if (source.owner || reviewers.length === 0) {
            logger.debug(lm('Reviewer is the owner', c, 1))
            const reviewerIdentity = await this.client.getIdentity(source.owner.id!)
            if (reviewerIdentity) {
                logger.debug(lm('Reviewer found', c, 1))
                reviewers.push(reviewerIdentity.id!)
            } else {
                logger.error(lm(`Reviewer not found ${source.owner.name}`, c, 1))
            }
        } else {
            logger.warn(lm(`No reviewer provided. Merging forms will not be processed.`, c, 1))
        }

        return reviewers
    }

    async processFormInstance(
        formInstance: FormInstanceResponseBeta
    ): Promise<{ decision: string; account: string; message: string }> {
        const c = 'processFormInstance'
        const now = new Date().toISOString()
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
            const source = (formInstance.formInput!.source as any).value
            message = `Assignment approved by ${reviewerName}`
        }

        return { decision, account, message }
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
        let combinedAttributes: Map<string, AttributeDefinition> = new Map()
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
                name: 'status',
                description: 'Status',
                type: 'string',
                multi: true,
                entitlement: true,
                managed: false,
                schemaObjectType: 'status',
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

    handleError(error: any) {
        let message = error
        if (error instanceof Error) {
            let message = error.message
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
