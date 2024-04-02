export interface Config {
    attributeMerge: 'multi' | 'concatenate' | 'first'
    baseurl: string
    beforeProvisioningRule: string | null
    clientId: string
    clientSecret: string
    cloudCacheUpdate: number
    cloudDisplayName: string
    cloudExternalId: string
    commandType: string
    connectionType: string
    connectorName: string
    deleteThresholdPercentage: number
    deleteEmpty: boolean
    formPath: string | null
    healthy: boolean
    idnProxyType: string
    invocationId: string
    managementWorkgroup: string | null
    merging_attributes: string[]
    merging_expirationDays: number
    merging_map: {
        account: string[]
        identity: string
        uidOnly: boolean
        attributeMerge?: 'multi' | 'concatenate' | 'first' | 'source'
        source: string | undefined
    }[]
    merging_reviewer: string | undefined
    merging_score: number
    since: string
    sourceDescription: string
    sources: string[]
    spConnectorInstanceId: string
    spConnectorSpecId: string
    spConnectorSupportsCustomSchemas: boolean
    status: string
    templateApplication: string
    uid_case: 'same' | 'lower' | 'upper'
    uid_digits: number
    uid_normalize: boolean
    uid_scope: 'source' | 'platform'
    uid_spaces: boolean
    uid_template: string
    version: number
    reset: boolean
    includeExisting: boolean
}
