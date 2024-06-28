import {
    Account,
    FormDefinitionResponseBeta,
    FormInstanceResponseBeta,
    IdentityDocument,
    Source,
    WorkflowBeta,
} from 'sailpoint-api-client'
import { Config } from './model/config'
import { SDKClient } from './sdk-client'
import { AccountSchema, Context, logger, readConfig } from '@sailpoint/connector-sdk'
import {
    buildDynamicSchema,
    buildReviewersMap,
    getEmailWorkflow,
    getExpirationDate,
    getFormName,
    getInputFromDescription,
    getOwnerFromSource,
    lm,
    logErrors,
    processFormInstance,
    processUncorrelatedAccount,
    refreshAccount,
    sendEmail,
    updateAccountLinks,
} from './utils'
import { WORKFLOW_NAME } from './constants'
import { UniqueForm } from './model/form'
import { buildUniqueAccount, buildUniqueAccountFromID, buildUniqueID } from './utils/unique'
import { Email } from './model/email'
import { UniqueAccount } from './model/account'
import { AxiosError } from 'axios'
import { v4 as uuidv4 } from 'uuid'

export class ContextHelper {
    private c: string = 'ContextHelper'
    private emailer?: WorkflowBeta
    private sources: Source[]
    private client?: SDKClient
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
        logger.debug(lm(`Reading config.`, this.c))
        this.config = (await readConfig()) as Config
        this.config!.merging_map = this.config?.merging_map || []
        logger.debug(lm(`Initializing SDK client.`, this.c))
        this.client = new SDKClient(this.config)

        logger.debug(lm(`Looking for connector instance`, this.c))
        const id = this.config?.spConnectorInstanceId as string
        const allSources = await this.client.listSources()
        this.source = allSources.find((x) => (x.connectorAttributes as any).spConnectorInstanceId === id)
        this.sources = allSources.filter((x) => this.config?.sources.includes(x.name))

        if (!this.source) {
            throw new Error('No connector source was found on the tenant.')
        }

        logger.debug(lm(`Initializing SDK client.`, this.c))
        const owner = getOwnerFromSource(this.source)
        const wfName = `${WORKFLOW_NAME} (${this.config!.cloudDisplayName})`
        this.emailer = await getEmailWorkflow(this.client, wfName, owner)

        if (!this.emailer) {
            throw new Error('Unable to instantiate email workflow')
        }

        this.reviewerIDs = await buildReviewersMap(this.client, this.config, this.source, this.sources)

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

    private getClient(): SDKClient {
        return this.client!
    }

    getSource(): Source {
        return this.source!
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
        const c = 'getIdentities'
        logger.info(lm('Fetching identities.', c))
        const identities = await this.getClient().listIdentities()

        return identities ? identities : []
    }

    getIdentityById(id: string): IdentityDocument | undefined {
        return this.identities.find((x) => x.id === id)
    }

    getIdentityByUID(uid: string): IdentityDocument | undefined {
        return this.identities.find((x) => x.attributes!.uid === uid)
    }

    private async listAccounts(): Promise<Account[]> {
        const c = 'getAccounts'
        const client = this.getClient()
        const source = this.getSource()

        logger.info(lm('Fetching existing accounts.', c))
        let accounts = await client.listAccountsBySource(source.id!)
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
        const client = this.getClient()

        const account = await client.getAccount(id)

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
        const c = 'getAuthoritativeAccounts'
        const client = this.getClient()
        const sources = this.listSources()

        logger.info(lm('Fetching authoritative accounts.', c))
        const authoritativeAccounts = await client.listAccounts(sources.map((x) => x.id!))

        return authoritativeAccounts
    }

    async listUniqueAccounts(): Promise<UniqueAccount[]> {
        const c = 'getUniqueAccounts'
        const accounts: UniqueAccount[] = []
        const uuids: string[] = []

        logger.debug(lm('Updating existing account links.', c))
        for (const account of this.accounts) {
            updateAccountLinks(account, this.identities, this.config.sources)
        }
        if (this.config?.deleteEmpty) {
            this.accounts = this.accounts.filter(
                (x) =>
                    !(
                        x.uncorrelated === false &&
                        x.attributes!.accounts.length === 0 &&
                        !x.attributes!.status.includes('reviewer')
                    )
            )
        }

        for (const account of this.accounts) {
            while (!account.attributes!.uuid) {
                const uuid = uuidv4()
                if (!uuids.includes(uuid)) {
                    uuids.push(uuid)
                    account.attributes!.uuid = uuid
                }
            }
        }

        for (const acc of this.accounts) {
            const uniqueAccount = await this.getUniqueAccount(acc)
            if (uniqueAccount) {
                accounts.push(uniqueAccount)
                if (uniqueAccount.attributes.uuid) {
                    uuids.push(uniqueAccount.attributes.uuid as string)
                }
            }
        }

        return accounts
    }

    async getUniqueAccount(account: Account): Promise<UniqueAccount | undefined> {
        const sources = this.sources.map((x) => x.name)
        const client = this.getClient()
        const schema = await this.getSchema()

        let sourceAccounts: Account[] = []
        for (const sourceName of sources) {
            const accounts = this.authoritativeAccounts.filter(
                (x) => x.sourceName === sourceName && account.attributes!.accounts.includes(x.id)
            )
            sourceAccounts = sourceAccounts.concat(accounts)
        }
        if (sourceAccounts.length === 0) sourceAccounts.push(account)

        try {
            const uniqueAccount = await refreshAccount(
                account,
                sourceAccounts,
                schema,
                this.identities,
                this.config,
                client
            )

            return uniqueAccount
        } catch (error) {
            logger.error(error as string)
        }
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
        const client = this.getClient()

        const forms = await client.listForms()
        const currentForms = forms.filter((x) => x.name?.startsWith(this.getFormName()))

        return currentForms
    }

    async createUniqueForm(form: UniqueForm): Promise<FormDefinitionResponseBeta> {
        const client = this.getClient()

        const response = await client.createForm(form)
        this.forms.push(response)

        return response
    }

    async deleteForm(form: FormDefinitionResponseBeta) {
        const client = this.getClient()

        await client.deleteForm(form.id!)

        const index = this.forms.findIndex((x) => x.id === form.id!)
        this.forms.splice(index, 1)
    }

    async getFormInstances(forms?: FormDefinitionResponseBeta[]): Promise<FormInstanceResponseBeta[]> {
        const client = this.getClient()

        let formInstances = await client.listFormInstances()
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

    async processFormInstance(
        formInstance: FormInstanceResponseBeta
    ): Promise<{ decision: string; account: string; message: string }> {
        return processFormInstance(this.getClient(), formInstance)
    }

    async createFormInstance(form: FormDefinitionResponseBeta, reviewerID: string) {
        const client = this.getClient()
        const source = this.getSource()

        const expire = getExpirationDate(this.config)
        const formInput = form.formInput?.reduce(getInputFromDescription, {})

        const currentFormInstance = await client.createFormInstance(
            form.id!,
            formInput!,
            [reviewerID],
            source.id!,
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
        const source = this.getSource()
        const deduplicate = await this.isMergingEnabled()

        const response = await processUncorrelatedAccount(
            uncorrelatedAccount,
            this.accounts,
            this.currentIdentities,
            source,
            this.config,
            deduplicate
        )

        return response
    }

    async buildUniqueAccount(account: Account, status: string, msg: string): Promise<Account> {
        const uniqueAccount = await buildUniqueAccount(account, status, msg, this.identities, this.ids, this.config)
        this.ids.push(uniqueAccount.attributes!.uniqueID)
        this.accounts.push(uniqueAccount)

        return uniqueAccount
    }

    async buildUniqueAccountFromID(id: string): Promise<UniqueAccount> {
        const client = this.getClient()
        const source = this.getSource()
        const schema = await this.getSchema()

        const uniqueAccount = await buildUniqueAccountFromID(id, schema, source, this.identities, this.config, client)

        return uniqueAccount
    }

    async buildUniqueID(id: string): Promise<string> {
        const client = this.getClient()
        const source = this.getSource()

        const account = await client.getAccountBySourceAndNativeIdentity(source.id!, id)
        const uniqueID = await buildUniqueID(account!, this.ids, this.config)
        this.ids.push(uniqueID)

        return uniqueID
    }

    async sendEmail(email: Email) {
        const client = this.getClient()

        await sendEmail(email, this.emailer!, client)
    }

    loadSchema(schema: AccountSchema) {
        this.schema = schema
    }

    async getSchema(): Promise<AccountSchema> {
        const client = this.getClient()
        const sources = this.listSources()

        let schema: AccountSchema
        if (this.schema) {
            schema = this.schema
        } else {
            schema = await buildDynamicSchema(sources, this.config, client)
        }

        return schema
    }

    getEmailer(): WorkflowBeta {
        return this.emailer!
    }

    async logErrors(context: Context, input: any) {
        const source = this.getSource()
        const workflow = this.getEmailer()
        const client = this.getClient()

        if (this.errors.length > 0) {
            await logErrors(context, input, this.errors, source, workflow, client)
        }
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
}
