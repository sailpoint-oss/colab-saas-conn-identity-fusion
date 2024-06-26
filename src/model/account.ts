import { AccountSchema, Attributes, StdAccountListOutput } from '@sailpoint/connector-sdk'
import { Account } from 'sailpoint-api-client'
import { combineArrays } from '../utils'

export class UniqueAccount implements StdAccountListOutput {
    identity: string
    uuid: string
    attributes: Attributes
    disabled: boolean

    constructor(account: Account, schema?: AccountSchema) {
        this.disabled = account.uncorrelated
        this.attributes = account.attributes
        this.attributes.IIQDisabled = this.disabled

        const accountsCount = account.attributes.accounts.length
        let status = this.attributes.status as string[]
        if (accountsCount === 0) {
            this.attributes.status = combineArrays(status, ['orphan'])
        } else if (status.includes('orphan')) {
            status.splice(status.indexOf('orphan'), 1)
        }

        if (schema) {
            this.identity = account.attributes[schema.identityAttribute]
                ? account.attributes[schema.identityAttribute]
                : account.attributes.uuid
            this.uuid = account.attributes[schema.displayAttribute]
                ? account.attributes[schema.displayAttribute]
                : account.attributes.uuid
        } else {
            this.identity = account.attributes.uuid
            this.uuid = account.attributes.uuid
        }
        // if (status.includes('reviewer')) {
        //     this.uuid = account.name
        //     this.attributes.uuid = account.name
        // }
    }
}
