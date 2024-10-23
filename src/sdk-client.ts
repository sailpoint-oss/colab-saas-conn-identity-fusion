import axiosRetry from 'axios-retry'
import {
    Configuration,
    CreateFormDefinitionRequestBeta,
    CreateFormInstanceRequestBeta,
    CustomFormsBetaApi,
    CustomFormsBetaApiFactory,
    FormDefinitionResponseBeta,
    FormInstanceCreatedByBeta,
    FormInstanceRecipientBeta,
    FormInstanceResponseBeta,
    FormInstanceResponseBetaStateEnum,
    Paginator,
    Search,
    SearchApi,
    SourcesApi,
    Account,
    WorkflowsBetaApi,
    WorkflowsBetaApiCreateWorkflowRequest,
    WorkflowBeta,
    TestWorkflowRequestBeta,
    PostExternalExecuteWorkflowRequestBeta,
    WorkflowOAuthClientBeta,
    IdentityProfilesBetaApi,
    IdentityAttributeConfigBeta,
    EntitlementsBetaApi,
    EntitlementBeta,
    IdentityBeta,
    IdentitiesBetaApiListIdentitiesRequest,
    IdentitiesBetaApi,
    WorkgroupDtoBeta,
    GovernanceGroupsBetaApi,
    ListWorkgroupMembers200ResponseInnerBeta,
} from 'sailpoint-api-client'
import { AxiosRequestConfig } from 'axios'
import {
    AccountsApi,
    AccountsApiGetAccountRequest,
    AccountsApiListAccountsRequest,
    IdentityDocument,
    JsonPatchOperation,
    Transform,
    TransformsApi,
} from 'sailpoint-api-client/dist/v3'
import { URL } from 'url'
import { logger } from '@sailpoint/connector-sdk'

const TOKEN_URL_PATH = '/oauth/token'

function sleep(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms))
}

export class SDKClient {
    private config: Configuration

    constructor(config: any) {
        const tokenUrl = new URL(config.baseurl).origin + TOKEN_URL_PATH
        this.config = new Configuration({ ...config, tokenUrl })
        this.config.retriesConfig = {
            retries: 10,
            // retryDelay: (retryCount) => { return retryCount * 2000; },
            retryDelay: (retryCount, error) => axiosRetry.exponentialDelay(retryCount, error, 2000),
            retryCondition: (error) => {
                return (
                    axiosRetry.isNetworkError(error) ||
                    axiosRetry.isRetryableError(error) ||
                    error.response?.status === 429
                )
            },
            onRetry: (retryCount, error, requestConfig) => {
                logger.debug(
                    `Retrying API [${requestConfig.url}] due to request error: [${error}]. Try number [${retryCount}]`
                )
            },
        }
        // this.config.retriesConfig = {
        //     retries: 5,
        //     retryDelay: axiosRetry.exponentialDelay,
        //     retryCondition: axiosRetry.isRetryableError,
        // }
    }

    async listIdentities(): Promise<IdentityDocument[]> {
        const api = new SearchApi(this.config)
        const search: Search = {
            indices: ['identities'],
            query: {
                query: '*',
            },
            sort: ['name'],
            includeNested: true,
        }

        const response = await Paginator.paginateSearchApi(api, search)
        return response.data as IdentityDocument[]
    }

    async getIdentityByUID(uid: string): Promise<IdentityBeta | undefined> {
        const api = new IdentitiesBetaApi(this.config)

        const requestParameters: IdentitiesBetaApiListIdentitiesRequest = {
            filters: `alias eq "${uid}"`,
        }
        const response = await api.listIdentities(requestParameters)

        if (response.data.length > 0) {
            return response.data[0]
        } else {
            return undefined
        }
    }

    async listIdentitiesBySource(id: string): Promise<IdentityDocument[]> {
        const api = new SearchApi(this.config)
        const search: Search = {
            indices: ['identities'],
            query: {
                query: `@accounts(source.id.exact:"${id}")`,
            },
            includeNested: true,
        }

        const response = await api.searchPost({ search })

        return response.data as IdentityDocument[]
    }

    async getIdentityBySearch(id: string): Promise<IdentityDocument | undefined> {
        const api = new SearchApi(this.config)
        const search: Search = {
            indices: ['identities'],
            query: {
                query: `id:${id}`,
            },
            includeNested: true,
        }

        const response = await api.searchPost({ search })

        return response.data[0] as IdentityDocument | undefined
    }

    async getIdentity(id: string): Promise<IdentityBeta | undefined> {
        const api = new IdentitiesBetaApi(this.config)

        const response = await api.getIdentity({ id })

        return response.data
    }

    async getAccountsByIdentity(id: string): Promise<Account[]> {
        const api = new AccountsApi(this.config)
        const filters = `identityId eq "${id}"`

        const response = await api.listAccounts({ filters })

        return response.data
    }

    async listAccountsBySource(id: string): Promise<Account[]> {
        const api = new AccountsApi(this.config)
        const filters = `sourceId eq "${id}"`
        const search = async (
            requestParameters?: AccountsApiListAccountsRequest | undefined,
            axiosOptions?: AxiosRequestConfig<any> | undefined
        ) => {
            return await api.listAccounts({ ...requestParameters, filters })
        }

        const response = await Paginator.paginate(api, search)

        return response.data
    }

    async getAccountBySourceAndNativeIdentity(sourceId: string, nativeIdentity: string): Promise<Account | undefined> {
        const api = new AccountsApi(this.config)
        const filters = `sourceId eq "${sourceId}" and nativeIdentity eq "${nativeIdentity}"`
        const search = async (
            requestParameters?: AccountsApiListAccountsRequest | undefined,
            axiosOptions?: AxiosRequestConfig<any> | undefined
        ) => {
            return await api.listAccounts({ ...requestParameters, filters })
        }

        const response = await api.listAccounts({ filters })

        return response.data.length > 0 ? response.data[0] : undefined
    }

    async listUncorrelatedAccounts(sourceIds?: string[]): Promise<Account[]> {
        const api = new AccountsApi(this.config)
        let filters = 'uncorrelated eq true'
        if (sourceIds) {
            const sourceValues = sourceIds.map((x) => `"${x}"`).join(', ')
            filters += ` and sourceId in (${sourceValues})`
        }
        const search = async (
            requestParameters?: AccountsApiListAccountsRequest | undefined,
            axiosOptions?: AxiosRequestConfig<any> | undefined
        ) => {
            return await api.listAccounts({ ...requestParameters, filters })
        }

        const response = await Paginator.paginate(api, search)

        return response.data
    }

    async listCorrelatedAccounts(sourceIds?: string[]): Promise<Account[]> {
        const api = new AccountsApi(this.config)
        let filters = 'uncorrelated eq false'
        if (sourceIds) {
            const sourceValues = sourceIds.map((x) => `"${x}"`).join(', ')
            filters += ` and sourceId in (${sourceValues})`
        }
        const search = async (
            requestParameters?: AccountsApiListAccountsRequest | undefined,
            axiosOptions?: AxiosRequestConfig<any> | undefined
        ) => {
            return await api.listAccounts({ ...requestParameters, filters })
        }

        const response = await Paginator.paginate(api, search)

        return response.data
    }

    async listAccounts(sourceIds?: string[]): Promise<Account[]> {
        const api = new AccountsApi(this.config)
        let filters: string | undefined
        if (sourceIds) {
            const sourceValues = sourceIds.map((x) => `"${x}"`).join(', ')
            filters = `sourceId in (${sourceValues})`
        }
        const search = async (
            requestParameters?: AccountsApiListAccountsRequest | undefined,
            axiosOptions?: AxiosRequestConfig<any> | undefined
        ) => {
            return await api.listAccounts({ ...requestParameters, filters })
        }

        const response = await Paginator.paginate(api, search)

        return response.data
    }

    async getAccount(id: string): Promise<Account | undefined> {
        const api = new AccountsApi(this.config)
        const requestParameters: AccountsApiGetAccountRequest = { id }

        try {
            const response = await api.getAccount(requestParameters)
            return response.data
        } catch (e) {
            return undefined
        }
    }

    // async getIdenticalIdentities(sourceId: string, attributes: object): Promise<IdentityDocument[]> {
    //     if (Object.keys(attributes).length > 0) {
    //         const conditions: string[] = []
    //         conditions.push(`@accounts(source.id:${sourceId})`)
    //         // conditions.push(`NOT attributes.uid.exact:"${uid}"`)
    //         for (const [key, value] of Object.entries(attributes) as [string, string][]) {
    //             conditions.push(`attributes.${key}.exact:"${value}"`)
    //         }
    //         const query = conditions.join(' AND ')
    //         const api = new SearchApi(this.config)
    //         const search: Search = {
    //             indices: ['identities'],
    //             query: {
    //                 query,
    //             },
    //             sort: ['-name'],
    //             includeNested: false,
    //         }

    //         const response = await Paginator.paginateSearchApi(api, search, undefined, this.batchSize)
    //         return response.data
    //     } else {
    //         return []
    //     }
    // }

    // async getSimilarIdentities(sourceId: string, attributes: object): Promise<IdentityDocument[]> {
    //     if (Object.keys(attributes).length > 0) {
    //         const conditions: string[] = []
    //         // conditions.push(`NOT attributes.uid.exact:"${uid}"`)
    //         conditions.push(`@accounts(source.id:${sourceId})`)
    //         for (const [key, value] of Object.entries(attributes) as [string, string][]) {
    //             const subconditions: string[] = []
    //             subconditions.push(`attributes.${key}.exact:/.*${value}.*/`)
    //             subconditions.push(`attributes.${key}:"${value}"~1`)
    //             const subquery = subconditions.join(' OR ')
    //             conditions.push(subquery)
    //         }
    //         const query = conditions.map((x) => `(${x})`).join(' AND ')
    //         const api = new SearchApi(this.config)
    //         const search: Search = {
    //             indices: ['identities'],
    //             query: {
    //                 query,
    //             },
    //             sort: ['-name'],
    //             includeNested: false,
    //         }

    //         const response = await Paginator.paginateSearchApi(api, search, undefined, this.batchSize)
    //         return response.data
    //     } else {
    //         return []
    //     }
    // }

    async listWorkgroups(): Promise<WorkgroupDtoBeta[]> {
        const api = new GovernanceGroupsBetaApi(this.config)

        const response = await Paginator.paginate(api, api.listWorkgroups)

        return response.data
    }

    async listWorkgroupMembers(workgroupId: string): Promise<ListWorkgroupMembers200ResponseInnerBeta[]> {
        const api = new GovernanceGroupsBetaApi(this.config)
        const response = await api.listWorkgroupMembers({ workgroupId })

        return response.data
    }

    async listSources() {
        const api = new SourcesApi(this.config)

        const response = await Paginator.paginate(api, api.listSources)

        return response.data
    }

    async listSourceSchemas(sourceId: string) {
        const api = new SourcesApi(this.config)

        const response = await api.listSourceSchemas({ sourceId })

        return response.data
    }

    async listForms(): Promise<FormDefinitionResponseBeta[]> {
        const api = new CustomFormsBetaApi(this.config)

        const response = await api.searchFormDefinitionsByTenant()

        return response.data.results ? response.data.results : []
    }

    async deleteForm(formDefinitionID: string): Promise<void> {
        const api = new CustomFormsBetaApi(this.config)

        const response = await api.deleteFormDefinition({ formDefinitionID })
    }

    async listFormInstances(): Promise<FormInstanceResponseBeta[]> {
        const api = new CustomFormsBetaApi(this.config)

        const response = await api.searchFormInstancesByTenant()

        return response.data ? (response.data as FormInstanceResponseBeta[]) : []
    }

    async createTransform(transform: Transform): Promise<Transform> {
        const api = new TransformsApi(this.config)

        const response = await api.createTransform({ transform })

        return response.data
    }

    async listWorkflows(): Promise<WorkflowBeta[]> {
        const api = new WorkflowsBetaApi(this.config)

        const response = await api.listWorkflows()

        return response.data
    }

    async correlateAccount(identityId: string, id: string): Promise<object> {
        const api = new AccountsApi(this.config)
        const jsonPatchOperation: JsonPatchOperation[] = [
            {
                op: 'replace',
                path: '/identityId',
                value: identityId,
            },
        ]
        const response = await api.updateAccount({ id, jsonPatchOperation })

        return response.data
    }

    async createForm(form: CreateFormDefinitionRequestBeta): Promise<FormDefinitionResponseBeta> {
        const api = new CustomFormsBetaApi(this.config)

        const response = await api.createFormDefinition({
            body: form,
        })

        return response.data
    }

    async createFormInstance(
        formDefinitionId: string,
        formInput: { [key: string]: any },
        recipientList: string[],
        sourceId: string,
        expire: string
    ): Promise<FormInstanceResponseBeta> {
        const api = CustomFormsBetaApiFactory(this.config)

        const recipients: FormInstanceRecipientBeta[] = recipientList.map((x) => ({ id: x, type: 'IDENTITY' }))
        const createdBy: FormInstanceCreatedByBeta = {
            id: sourceId,
            type: 'SOURCE',
        }
        const body: CreateFormInstanceRequestBeta = {
            formDefinitionId,
            recipients,
            createdBy,
            expire,
            formInput,
            standAloneForm: true,
        }

        const response = await api.createFormInstance(body)

        return response.data
    }

    async setFormInstanceState(
        formInstanceId: string,
        state: FormInstanceResponseBetaStateEnum
    ): Promise<FormInstanceResponseBeta> {
        const api = CustomFormsBetaApiFactory(this.config)

        const body: { [key: string]: any }[] = [
            {
                op: 'replace',
                path: '/state',
                value: state,
            },
        ]
        const response = await api.patchFormInstance(formInstanceId, body)

        return response.data
    }

    async createWorkflow(workflow: WorkflowsBetaApiCreateWorkflowRequest): Promise<WorkflowBeta> {
        const api = new WorkflowsBetaApi(this.config)

        const response = await api.createWorkflow(workflow)

        return response.data
    }

    async createWorkflowExternalTrigger(id: string): Promise<WorkflowOAuthClientBeta> {
        const api = new WorkflowsBetaApi(this.config)

        const response = await api.postWorkflowExternalTrigger({ id })

        return response.data
    }

    async testWorkflow(id: string, testWorkflowRequestBeta: TestWorkflowRequestBeta) {
        const api = new WorkflowsBetaApi(this.config)

        const response = await api.testWorkflow({
            id,
            testWorkflowRequestBeta,
        })
    }

    async triggerWorkflowExternal(
        id: string,
        postExternalExecuteWorkflowRequestBeta: PostExternalExecuteWorkflowRequestBeta
    ) {
        const api = new WorkflowsBetaApi(this.config)

        const response = await api.postExternalExecuteWorkflow({
            id,
            postExternalExecuteWorkflowRequestBeta,
        })
    }

    async listEntitlementsBySource(id: string): Promise<EntitlementBeta[]> {
        const api = new EntitlementsBetaApi(this.config)

        const filters = `source.id eq "${id}"`

        const search = async (
            requestParameters?: AccountsApiListAccountsRequest | undefined,
            axiosOptions?: AxiosRequestConfig<any> | undefined
        ) => {
            return await api.listEntitlements({ ...requestParameters, filters })
        }

        const response = await Paginator.paginate(api, search)

        return response.data
    }

    async getTransformByName(name: string): Promise<Transform | undefined> {
        const api = new TransformsApi(this.config)

        const response = await api.listTransforms()

        return response.data.find((x) => x.name === name)
    }

    async testTransform(
        identityId: string,
        identityAttributeConfig: IdentityAttributeConfigBeta
    ): Promise<string | undefined> {
        const api = new IdentityProfilesBetaApi(this.config)

        const response = await api.generateIdentityPreview({
            identityPreviewRequestBeta: { identityId, identityAttributeConfig },
        })
        const attributes = response.data.previewAttributes
        const testAttribute = attributes?.find((x) => x.name === 'uid')

        return testAttribute && testAttribute.value ? testAttribute.value.toString() : undefined
    }
}
