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
    getEmailWorkflow,
    getExpirationDate,
    getFormName,
    getInputFromDescription,
    getOwnerFromSource,
    getReviewerIDs,
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
    private config?: Config
    private reviewerIDs: string[]
    private source?: Source
    schema?: AccountSchema
    ids: string[]
    identities: IdentityDocument[]
    currentIdentities: IdentityDocument[]
    accounts: Account[]
    authoritativeAccounts: Account[]
    forms: FormDefinitionResponseBeta[]
    formInstances: FormInstanceResponseBeta[]
    errors: string[]

    constructor() {
        this.sources = []
        this.ids = []
        this.identities = []
        this.currentIdentities = []
        this.reviewerIDs = []
        this.accounts = []
        this.authoritativeAccounts = []
        this.forms = []
        this.formInstances = []
        this.errors = []
    }

    /**
     * Initializes the configuration, source configs, and, optionally, the set of
     * identities and accounts already in ISC for aggregation.
     * 
     * @param skipData If all identity and account data should be pulled
     */
    async init(skipData?: boolean) {
        logger.debug(lm(`Reading config.`, this.c))
        this.config = await readConfig()
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

        this.reviewerIDs = await getReviewerIDs(this.client, this.config?.merging_reviewer)

        if (!skipData) {
            // For full aggregation
            this.identities = await this.getIdentities()
            this.accounts = await this.getAccounts()
            const identityIDs = this.accounts.map((x) => x.identityId)
            this.authoritativeAccounts = await this.getAuthoritativeAccounts()
            this.currentIdentities = this.identities.filter((x) => identityIDs.includes(x.id))
            this.forms = await this.getForms()
            this.formInstances = await this.getFormInstances(this.forms)
        } else {
            // For read-account, we don't need everybody else's data
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

    async getConfig(): Promise<Config> {
        if (this.config) {
            return this.config
        } else {
            return await readConfig()
        }
    }

    /**
     * @returns The Identity Fusion source
     */
    getSource(): Source {
        return this.source!
    }

    /**
     * @returns The list of Source objects corresponding to the configured auth sources in the Fusion source
     */
    getSources(): Source[] {
        return this.sources
    }

    getReviewerIDs(): string[] {
        return this.reviewerIDs
    }

    /**
     * @returns All (indexed) identities in the ISC system
     */
    async getIdentities(): Promise<IdentityDocument[]> {
        const c = 'getIdentities'
        logger.info(lm('Fetching identities.', c))
        const identities = await this.getClient().listIdentities()

        return identities ? identities : []
    }

    async loadIdentities() {
        this.identities = await this.getIdentities()
    }

    /**
     * Retrieves all existing Fusion account objects (for the configured Source)
     * 
     * @returns The account data
     */
    async getAccounts(): Promise<Account[]> {
        const c = 'getAccounts'
        const config = await this.getConfig()
        const client = this.getClient()

        // Fusion source
        const source = this.getSource()

        logger.info(lm('Fetching existing accounts.', c))
        let existingFusionAccounts = await client.listAccountsBySource(source.id!)
        existingFusionAccounts = existingFusionAccounts || []

        logger.debug(lm('Updating existing account links.', c))
        for (const account of existingFusionAccounts) {
            updateAccountLinks(account, this.identities, config.sources)
            account.attributes.accounts = account.attributes.accounts || []
            account.attributes.status = account.attributes.status || []
            account.attributes.reviews = account.attributes.reviews || []
            account.attributes.history = account.attributes.history || []
        }
        if (this.config?.deleteEmpty) {
            existingFusionAccounts = existingFusionAccounts.filter(
                (x) =>
                    !(
                        x.uncorrelated === false &&
                        x.attributes.accounts.length === 0 &&
                        !x.attributes.status.includes('reviewer')
                    )
            )
        }

        return existingFusionAccounts
    }

    async getAccount(id: string): Promise<Account | undefined> {
        const client = this.getClient()

        const account = await client.getAccount(id)

        return account
    }

    async getAuthoritativeAccounts(): Promise<Account[]> {
        const c = 'getAuthoritativeAccounts'
        const client = this.getClient()
        const sources = this.getSources()

        logger.info(lm('Fetching authoritative accounts.', c))
        const authoritativeAccounts = await client.listAccounts(sources.map((x) => x.id!))

        return authoritativeAccounts
    }

    async getUniqueAccounts(): Promise<UniqueAccount[]> {
        const accounts: UniqueAccount[] = []
        const uuids: string[] = []

        for (const account of this.accounts) {
            while (!account.attributes.uuid) {
                const uuid = uuidv4()
                if (!uuids.includes(uuid)) {
                    uuids.push(uuid)
                    account.attributes.uuid = uuid
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
        const config = await this.getConfig()
        const client = this.getClient()
        const schema = await this.getSchema()

        const sourceAccounts: Account[] = []
        for (const sourceName of sources) {
            const a = this.authoritativeAccounts.find(
                (x) => x.sourceName === sourceName && account.attributes.accounts.includes(x.id)
            )
            if (a) sourceAccounts.push(a)
        }
        if (sourceAccounts.length === 0) sourceAccounts.push(account)

        try {
            const uniqueAccount = await refreshAccount(account, sourceAccounts, schema, this.identities, config, client)

            return uniqueAccount
        } catch (error) {
            logger.error(error as string)
        }
    }

    getFormName(account?: Account): string {
        return getFormName(this.getSource().name, account)
    }

    async getForms(): Promise<FormDefinitionResponseBeta[]> {
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
        this.forms.splice(this.forms.indexOf(form), 1)
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
        const config = await this.getConfig()
        const client = this.getClient()
        const source = this.getSource()

        const expire = getExpirationDate(config)
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

    async isDeduplicationEnabled(): Promise<boolean> {
        const config = await this.getConfig()
        return (
            this.reviewerIDs.length > 0 &&
            config.merging_score !== undefined &&
            config.merging_expirationDays !== undefined
        )
    }

    async processUncorrelatedAccount(
        uncorrelatedAccount: Account
    ): Promise<{ processedAccount: Account | undefined; uniqueForm: UniqueForm | undefined }> {
        const config = await this.getConfig()
        const source = this.getSource()
        const deduplicate = await this.isDeduplicationEnabled()

        const response = await processUncorrelatedAccount(
            uncorrelatedAccount,
            this.accounts,
            this.currentIdentities,
            source,
            config,
            deduplicate
        )

        return response
    }

    async buildUniqueAccount(account: Account, status: string, msg: string): Promise<Account> {
        const config = await this.getConfig()

        const uniqueAccount = await buildUniqueAccount(account, status, msg, this.identities, this.ids, config)
        this.ids.push(uniqueAccount.attributes.id)
        this.accounts.push(uniqueAccount)

        return uniqueAccount
    }

    async buildUniqueAccountFromID(id: string): Promise<UniqueAccount> {
        const client = this.getClient()
        const config = await this.getConfig()
        const source = this.getSource()
        const schema = await this.getSchema()

        const uniqueAccount = await buildUniqueAccountFromID(id, schema, source, this.identities, config, client)

        return uniqueAccount
    }

    async buildUniqueID(id: string): Promise<string> {
        const client = this.getClient()
        const config = await this.getConfig()
        const source = this.getSource()

        const account = await client.getAccountBySourceAndNativeIdentity(source.id!, id)
        const uniqueID = await buildUniqueID(account!, this.ids, config)
        this.ids.push(uniqueID)

        return uniqueID
    }

    async sendEmail(email: Email) {
        const client = this.getClient()

        await sendEmail(email, this.emailer!, client)
    }

    async getSchema(): Promise<AccountSchema> {
        const client = this.getClient()
        const sources = this.getSources()

        let schema: AccountSchema
        if (this.schema) {
            schema = this.schema
        } else {
            const config = await this.getConfig()
            schema = await buildDynamicSchema(sources, config, client)
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

    handleError = (error: any) => {
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
