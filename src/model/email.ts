import { FormInstanceResponseBeta, IdentityDocument, Source, TestWorkflowRequestBeta } from 'sailpoint-api-client'
import { capitalizeFirstLetter, md } from '../utils'
import { AccountAnalysis } from './account'

export class ReviewEmail implements TestWorkflowRequestBeta {
    input: object
    constructor(recipient: IdentityDocument, formName: string, instance: FormInstanceResponseBeta) {
        const subject = formName
        let body = ''
        body += md.render(`Dear ${recipient.displayName},`)
        body += md.render(
            'The system has detected a potential match on one or more existing identities that needs your review. If this is not a match please select ‘This is a New Identity.'
        )

        body += md.render(`Click [here](${instance.standAloneFormUrl!}) to review the identities.`)

        body += md.render('Thank you,')
        body += md.render('IAM/Security Team')

        this.input = {
            recipients: [recipient.attributes!.email],
            subject,
            body,
        }
    }
}
//TODO
export class EditEmail implements TestWorkflowRequestBeta {
    input: object
    constructor(recipient: IdentityDocument, formName: string, instance: FormInstanceResponseBeta) {
        const subject = formName
        let body = ''
        body += md.render(`Dear ${recipient.displayName},`)
        body += md.render(
            'The system has detected a potential match on one or more existing identities that needs your review. If this is not a match please select ‘This is a New Identity.'
        )

        body += md.render(`Click [here](${instance.standAloneFormUrl!}) to review the identities.`)

        body += md.render('Thank you,')
        body += md.render('IAM/Security Team')

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

export class ReportEmail implements TestWorkflowRequestBeta {
    input: object
    constructor(analyses: AccountAnalysis[], attributes: string[], recipient: IdentityDocument) {
        const subject = `Identity Fusion report`

        let body = '\n'
        const attributeNames = attributes.map((x) => capitalizeFirstLetter(x))
        body += '| ' + ['ID', 'Name', 'Source name', ...attributeNames, 'Result'].join(' | ') + ' |\n'
        body += '|' + ' --- |'.repeat(4 + attributes.length) + '\n '
        for (const analysis of analyses) {
            const attributeValues = attributes.map((x) => analysis.account.attributes![x])
            const { nativeIdentity, name, sourceName } = analysis.account
            const result = analysis.results.map((x) => `- ${x}`).join('\n')
            const record = '| ' + [nativeIdentity, name, sourceName, ...attributeValues, result].join(' | ') + ' |\n'
            body += record
        }

        // table = md.render(table)
        body = md.render(body)
        body = body.replace(
            /<table>/g,
            '<table style="border-collapse: collapse;width: 100%;border: 1px solid #ccc;font-family: Arial, sans-serif;">'
        )
        body = body.replace(
            /<th>/g,
            '<th style="padding: 12px 15px;text-align: left;border-bottom: 1px solid #ddd;background-color: #4285f4; /* Blueish header color */color: white;">'
        )
        body = body.replace(/<td>/g, '<td style="padding: 12px 15px;text-align: left;border-bottom: 1px solid #ddd;">')
        this.input = {
            recipients: [recipient.attributes!.email],
            subject,
            body,
        }
    }
}
