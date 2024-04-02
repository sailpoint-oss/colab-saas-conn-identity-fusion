import { Attributes } from '@sailpoint/connector-sdk'

export type StatusSource = {
    name: string
    description: string
}

export class Status {
    identity: string
    uuid: string
    type: string = 'status'
    attributes: Attributes

    constructor(object: StatusSource) {
        this.attributes = {
            name: object.name,
            description: object.description,
        }
        this.identity = this.attributes.name as string
        this.uuid = this.attributes.name as string
    }
}
