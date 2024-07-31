import { AccountSchema, Attributes, StdAccountListOutput } from '@sailpoint/connector-sdk'
import { Account, IdentityDocument } from 'sailpoint-api-client'
import { combineArrays, deleteArrayItem } from '../utils'

export class UniqueAccount implements StdAccountListOutput {
    identity: string
    uuid: string
    attributes: Attributes
    disabled: boolean

    constructor(account: Account, schema?: AccountSchema) {
        this.disabled = account.uncorrelated
        this.attributes = account.attributes!
        this.attributes.IIQDisabled = this.disabled

        const accountsCount = account.attributes!.accounts.length
        let statuses = this.attributes.statuses as string[]
        if (accountsCount === 0 && !statuses.includes('reviewer')) {
            this.attributes.statuses = combineArrays(statuses, ['orphan'])
        } else if (statuses.includes('orphan')) {
            deleteArrayItem(statuses, 'orphan')
        }

        if (schema) {
            this.identity = account.attributes![schema.identityAttribute]
                ? account.attributes![schema.identityAttribute]
                : account.attributes!.uuid
            this.uuid = account.attributes![schema.displayAttribute]
                ? account.attributes![schema.displayAttribute]
                : account.attributes!.uuid
        } else {
            this.identity = account.attributes!.uuid
            this.uuid = account.attributes!.uuid
        }
        // if (status.includes('reviewer')) {
        //     this.uuid = account.name
        //     this.attributes.uuid = account.name
        // }
    }
}

export type SimilarAccountMatch = {
    identity: IdentityDocument
    score: Map<string, string>
}

export type AccountAnalysis = {
    account: Account
    results: string[]
    identicalMatch: IdentityDocument | undefined
    similarMatches: SimilarAccountMatch[]
}
