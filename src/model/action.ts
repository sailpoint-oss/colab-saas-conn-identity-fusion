import { Attributes } from '@sailpoint/connector-sdk'

export type ActionSource = {
    id: string
    name: string
    description: string
}

export class Action {
    identity: string
    uuid: string
    type: string = 'action'
    attributes: Attributes

    constructor(object: ActionSource) {
        this.attributes = { ...object }
        this.identity = this.attributes.id as string
        this.uuid = this.attributes.name as string
    }
}
