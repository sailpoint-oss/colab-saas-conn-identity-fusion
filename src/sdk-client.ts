import axios from 'axios'
import axiosRetry from 'axios-retry'
import axiosThrottle from 'axios-request-throttle'
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
    EntitlementsBetaApi,
    EntitlementBeta,
    IdentityBeta,
    IdentitiesBetaApi,
    WorkgroupDtoBeta,
    GovernanceGroupsBetaApi,
    ListWorkgroupMembers200ResponseInnerBeta,
    AccountsApi,
    AccountsApiGetAccountRequest,
    AccountsApiListAccountsRequest,
    IdentityDocument,
    JsonPatchOperation,
    ProvisioningPolicyDto,
    SearchDocument,
    SourcesApiCreateProvisioningPolicyRequest,
    SourcesApiGetProvisioningPolicyRequest,
    Transform,
    TransformsApi,
    UsageType,
    SourcesBetaApi,
    TaskManagementBetaApi,
} from 'sailpoint-api-client'
import { URL } from 'url'
import { logger } from '@sailpoint/connector-sdk'
import { REQUESTSPERSECOND, TASKRESULTRETRIES, TASKRESULTWAIT } from './constants'
import { AxiosError, AxiosResponseHeaders } from 'axios'

const TOKEN_URL_PATH = '/oauth/token'

const sleep = (ms: number) => {
    return new Promise((resolve) => setTimeout(resolve, ms))
}

const retryDelay = (retryCount: number, error: AxiosError): number => {
    const headers = error.response!.headers as AxiosResponseHeaders
    const retryAfter = headers.get('retry-after') as number

    return retryAfter ? retryAfter : 10 * 1000
}

export class SDKClient {
    private config: Configuration

    constructor(config: any) {
        const tokenUrl = new URL(config.baseurl).origin + TOKEN_URL_PATH
        this.config = new Configuration({ ...config, tokenUrl })
        this.config.retriesConfig = {
            retries: 5,
            retryDelay,
            retryCondition: (error) => {
                return (
                    axiosRetry.isNetworkError(error) ||
                    axiosRetry.isRetryableError(error) ||
                    error.response?.status === 429
                )
            },
            onRetry: (retryCount, error, requestConfig) => {
                logger.debug(
                    `Retrying API [${requestConfig.url}] due to request error: [${error}]. Retry number [${retryCount}]`
                )
                logger.error(error)
            },
        }
        axiosThrottle.use(axios, { requestsPerSecond: REQUESTSPERSECOND })
    }

    async listIdentities(attributes: string[]): Promise<IdentityDocument[]> {
        const api = new SearchApi(this.config)
        const search: Search = {
            indices: ['identities'],
            query: {
                query: '*',
            },
            sort: ['id'],
            includeNested: true,
            queryResultFilter: {
                includes: attributes,
            },
        }

        const response = await Paginator.paginateSearchApi(api, search)
        return response.data as IdentityDocument[]
    }

    async getIdentityByUID(uid: string): Promise<IdentityDocument | undefined> {
        const api = new SearchApi(this.config)

        const search: Search = {
            indices: ['identities'],
            query: {
                query: `attributes.uid.exact:"${uid}"`,
            },
            includeNested: true,
        }

        const response = await api.searchPost({ search, limit: 1 })

        if (response.data.length > 0) {
            return response.data[0] as IdentityDocument
        } else {
            return undefined
        }
    }

    async listIdentitiesByEntitlements(entitlements: string[]): Promise<IdentityDocument[]> {
        const api = new SearchApi(this.config)

        const query = entitlements.map((x) => `@access(value.exact:"${x}")`).join(' OR ')

        const search: Search = {
            indices: ['identities'],
            query: {
                query,
            },
            includeNested: true,
        }

        const response = await api.searchPost({ search })

        return response.data as IdentityDocument[]
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
        const search = async (requestParameters?: AccountsApiListAccountsRequest | undefined) => {
            return await api.listAccounts({ ...requestParameters, filters })
        }

        const response = await Paginator.paginate(api, search)

        return response.data
    }

    async getAccountBySourceAndNativeIdentity(id: string, nativeIdentity: string): Promise<Account | undefined> {
        const api = new AccountsApi(this.config)
        const filters = `sourceId eq "${id}" and nativeIdentity eq "${nativeIdentity}"`
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
        const search = async (requestParameters?: AccountsApiListAccountsRequest | undefined) => {
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
        const search = async (requestParameters?: AccountsApiListAccountsRequest | undefined) => {
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
        const search = async (requestParameters?: AccountsApiListAccountsRequest | undefined) => {
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

    async getAccountByIdentityID(identityId: string, sourceId: string): Promise<Account | undefined> {
        const api = new AccountsApi(this.config)
        const requestParameters: AccountsApiListAccountsRequest = {
            limit: 1,
            filters: `identityId eq "${identityId}" and sourceId eq "${sourceId}"`,
        }

        const response = await api.listAccounts(requestParameters)

        return response.data.length > 0 ? response.data[0] : undefined
    }

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

        const response = await api.getSourceSchemas({ sourceId })

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
        const requestBody: JsonPatchOperation[] = [
            {
                op: 'replace',
                path: '/identityId',
                value: identityId,
            },
        ]
        const response = await api.updateAccount({ id, requestBody })

        return response.data
    }

    async createForm(form: CreateFormDefinitionRequestBeta): Promise<FormDefinitionResponseBeta> {
        const api = new CustomFormsBetaApi(this.config)

        const response = await api.createFormDefinition({
            createFormDefinitionRequestBeta: form,
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

        const search = async (requestParameters?: AccountsApiListAccountsRequest | undefined) => {
            return await api.listEntitlements({ ...requestParameters, filters })
        }

        const response = await Paginator.paginate(api, search)

        return response.data
    }

    // async getTransformByName(name: string): Promise<Transform | undefined> {
    //     const api = new TransformsApi(this.config)

    //     const response = await api.listTransforms()

    //     return response.data.find((x) => x.name === name)
    // }

    // async testTransform(
    //     identityId: string,
    //     identityAttributeConfig: IdentityAttributeConfigBeta
    // ): Promise<string | undefined> {
    //     const api = new IdentityProfilesBetaApi(this.config)

    //     const response = await api.showGenerateIdentityPreview({
    //         identityPreviewRequestBeta: { identityId, identityAttributeConfig },
    //     })
    //     const attributes = response.data.previewAttributes
    //     const testAttribute = attributes?.find((x) => x.name === 'uid')

    //     return testAttribute && testAttribute.value ? testAttribute.value.toString() : undefined
    // }

    async getLatestAccountAggregation(sourceName: string): Promise<SearchDocument | undefined> {
        const api = new SearchApi(this.config)

        const search: Search = {
            indices: ['events'],
            query: {
                query: `operation:AGGREGATE AND status:PASSED AND objects:ACCOUNT AND target.name.exact:"${sourceName} [source]"`,
            },
            sort: ['-created'],
        }
        const response = await api.searchPost({ search, limit: 1 })

        return response.data.length === 0 ? undefined : response.data[0]
    }

    async aggregateAccounts(id: string): Promise<void> {
        const sourceApi = new SourcesBetaApi(this.config)

        const response = await sourceApi.importAccounts({ id })
        const taskApi = new TaskManagementBetaApi(this.config)

        let count = TASKRESULTRETRIES
        while (--count > 0) {
            const result = await taskApi.getTaskStatus({ id: response.data.task!.id! })
            if (result.data.completed) {
                break
            } else {
                await sleep(TASKRESULTWAIT)
            }
        }
    }

    async getProvisioningPolicy(sourceId: string, usageType: UsageType) {
        const api = new SourcesApi(this.config)

        const requestParameters: SourcesApiGetProvisioningPolicyRequest = {
            sourceId,
            usageType,
        }

        const response = await api.getProvisioningPolicy(requestParameters)

        return response.data
    }

    async createProvisioningPolicy(sourceId: string, provisioningPolicyDto: ProvisioningPolicyDto) {
        const api = new SourcesApi(this.config)

        const requestParameters: SourcesApiCreateProvisioningPolicyRequest = {
            sourceId,
            provisioningPolicyDto,
        }

        const response = await api.createProvisioningPolicy(requestParameters)

        return response.data
    }
}
