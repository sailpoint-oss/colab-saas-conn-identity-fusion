import { Attributes } from '@sailpoint/connector-sdk'

export type StatusSource = {
    id: string
    name: string
    description: string
}

export class Status {
    identity: string
    uuid: string
    type: string = 'status'
    attributes: Attributes

    constructor(object: StatusSource) {
        this.attributes = { ...object }
        this.identity = this.attributes.id as string
        this.uuid = this.attributes.name as string
    }
}
