import { FormInstanceResponseBeta, IdentityDocument, Source, TestWorkflowRequestBeta } from 'sailpoint-api-client'
import { md } from '../utils'

export class Email implements TestWorkflowRequestBeta {
    input: object
    constructor(recipient: IdentityDocument, formName: string, instance: FormInstanceResponseBeta) {
        const subject = formName
        let body = ''
        body += md.render(`Dear ${recipient.displayName},`)
        body += md.render(
            `The system has detected a potential match on one or more existing identities that needs your review. If this is not a match please select ‘This is a New Identity’.`
        )
        body += md.render(`Thank you,`)
        body += md.render(`Please use the link below to review the identities.`)
        body += md.render(instance.standAloneFormUrl!)
        body += md.render(`IAM/Security Team`)

        this.input = {
            recipients: [recipient.attributes!.email],
            subject,
            body,
        }
    }
}

export class ErrorEmail implements TestWorkflowRequestBeta {
    input: object
    constructor(source: Source, recipient: string, error: string) {
        const subject = `IdentityNow Identities [${source.name}] error report`
        const body = error
        this.input = {
            recipients: [recipient],
            subject,
            body,
        }
    }
}
