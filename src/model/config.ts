import { SourceManagementWorkgroup } from 'sailpoint-api-client'

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
    managementWorkgroup: SourceManagementWorkgroup | null
    merging_isEnabled: boolean
    global_merging_identical: boolean
    merging_attributes: string[]
    merging_expirationDays: number
    merging_map: {
        account: string[]
        identity: string
        uidOnly: boolean
        attributeMerge?: 'multi' | 'concatenate' | 'first' | 'source'
        source?: string
        merging_score?: number
    }[]
    global_merging_score: boolean
    merging_score?: number
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
    forceAggregation: boolean
    getScore: (attribute?: string) => number
}
