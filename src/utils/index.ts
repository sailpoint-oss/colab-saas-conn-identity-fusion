import {
    Account,
    BaseAccount,
    FormDefinitionInputBeta,
    FormDefinitionResponseBeta,
    FormInstanceResponseBeta,
    IdentityDocument,
    OwnerDto,
    Source,
} from 'sailpoint-api-client'
import { Context, logger } from '@sailpoint/connector-sdk'
import { Config } from '../model/config'
import { MSDAY, PADDING } from '../constants'

import MarkdownIt from 'markdown-it'
import os from 'os'

export const md = MarkdownIt({
    breaks: true,
    xhtmlOut: true,
})

//================ MISC ================
export const envInfo = () => {
    logger.info({ '--CPU--': os.cpus() })
}

export const sleep = (ms: number) => {
    return new Promise((resolve) => setTimeout(resolve, ms))
}

export const capitalizeFirstLetter = (str: string) => {
    return str.charAt(0).toUpperCase() + str.slice(1)
}

export const deleteArrayItem = (array: any[], item: string | number) => {
    if (array.includes(item)) {
        array.splice(array.indexOf(item, 1), 1)
    }
}

export const keepAlive = async (promise: Promise<any>) => {
    const interval = setInterval(() => {
        if (promise) {
            promise
                .then((result) => {
                    console.log(result)
                    clearInterval(interval) // Stops checking once the promise is resolved
                })
                .catch((error) => {
                    console.log(error)
                    clearInterval(interval) // Stops checking if the promise is rejected
                })
        }
    }, 5000) // Check every second
}

export const lm = (message: string, component?: string, indentations?: number): string => {
    // const component = lm.caller.name
    indentations = indentations || 0

    let output = ''
    for (let index = 0; index < indentations; index++) {
        output += PADDING
    }
    if (component) {
        output += `${component}: `
    }
    output += message

    return output
}

export const attrConcat = (list: string[]): string => {
    const set = new Set(list)

    return [...set]
        .sort()
        .map((x) => `[${x}]`)
        .join(' ')
}

export const attrSplit = (text: string): string[] => {
    const regex = /\[([^ ].+)\]/g
    const set = new Set<string>()

    let match = regex.exec(text)
    while (match) {
        set.add(match.pop() as string)
        match = regex.exec(text)
    }

    return set.size === 0 ? [text] : [...set]
}

export const getExpirationDate = (config: Config): string => {
    return new Date(new Date().valueOf() + MSDAY * config.merging_expirationDays).toISOString()
}

export const datedMessage = (message: string, account?: Account): string => {
    const now = new Date().toISOString().split('T')[0]
    let result = ''

    if (account) {
        result = `[${now}] ${message} [${account.name} (${account.sourceName})]`
    } else {
        result = `[${now}] ${message}`
    }

    return result
}

export const countKeys = (objects: { [key: string]: string }[]): Map<string, number> => {
    const count: Map<string, number> = new Map()

    for (const object of objects) {
        for (const key of Object.keys(object)) {
            if (count.has(key)) {
                count.set(key, (count.get(key) as number) + 1)
            } else {
                count.set(key, 1)
            }
        }
    }

    return count
}

export const getInputFromDescription = (
    p: { [key: string]: string },
    c: FormDefinitionInputBeta
): { [key: string]: string } => {
    p[c.id!] = c.description!
    return p
}

export const combineArrays = (a: any[] | undefined, b: any[] | undefined) => {
    const aArray = a || []
    const bArray = b || []

    return Array.from(new Set([...aArray, ...bArray]))
}

export const opLog = (config: any, input: any) => {
    logger.info({ '--Input--': input })
    logger.info({ '--Config--': config })
}

//================ SOURCES ================
export const getOwnerFromSource = (source: Source): OwnerDto => {
    return {
        type: 'IDENTITY',
        id: source.owner.id,
    }
}

//================ IDENTITIES ================
export const getAccountByIdentity = (identity: IdentityDocument, sourceID: string): BaseAccount | undefined => {
    return identity.accounts!.find((x) => x.source!.id === sourceID)
}

//================ ACCOUNTS ================

export const updateAccountLinks = (account: Account, identities: IdentityDocument[], sourceNames: string[]) => {
    if (account.uncorrelated === false && account.disabled === false) {
        const identity = identities.find((x) => x.id === account.identityId)
        const correlatedAccounts = identity?.accounts
            ?.filter((x) => sourceNames.includes(x.source!.name!))
            .map((x) => x.id as string)
        // Removing previously existing authoritative accounts and leaving only existing ones
        account.attributes!.accounts = combineArrays(correlatedAccounts, account.attributes!.accounts)
    }
}

export const normalizeAccountAttributes = (
    account: Account,
    mergingMap: {
        account: string[]
        identity: string
        uidOnly: boolean
        source?: string
    }[]
): Account => {
    const normalizedAccount = { ...account }
    for (const attribute of mergingMap) {
        if (!normalizedAccount.attributes![attribute.identity]) {
            for (const accAttribute of attribute.account) {
                if (normalizedAccount.attributes![accAttribute]) {
                    normalizedAccount.attributes![attribute.identity] = normalizedAccount.attributes![accAttribute]
                    break
                }
            }
        }
    }

    return normalizedAccount
}

//================ ATTRIBUTES ================

export const buildAccountAttributesObject = (
    account: Account,
    mergingMap: {
        account: string[]
        identity: string
        uidOnly: boolean
    }[],
    onlyMerging?: boolean
): {
    [key: string]: any
} => {
    const attributeObject: {
        [key: string]: any
    } = {}

    let maps: {
        account: string[]
        identity: string
        uidOnly: boolean
    }[]

    if (onlyMerging) {
        maps = mergingMap.filter((x) => x.uidOnly === false)
    } else {
        maps = mergingMap
    }

    for (const { identity: key, account: values } of maps) {
        for (const value of values.reverse()) {
            const v = account.attributes![value]
            if (v) {
                attributeObject[key] = account.attributes![value]
            }
        }
        if (!attributeObject[key]) {
            attributeObject[key] = ''
        }
    }

    return attributeObject
}

export const buildIdentityAttributesObject = (
    identity: IdentityDocument,
    mergingMap: {
        account: string[]
        identity: string
        uidOnly: boolean
    }[]
): {
    [key: string]: any
} => {
    const attributeObject: {
        [key: string]: any
    } = {}

    for (const { identity: key } of mergingMap.filter((x) => x.uidOnly === false)) {
        attributeObject[key] = identity.attributes![key]
    }

    return attributeObject
}

//================ WORKFLOWS ================

export const composeErrorMessage = (context: Context, input: any, errors: string[]): string => {
    let message = ''
    message += md.render('## Context')
    message += md.render('```json')
    message += md.render(JSON.stringify(context))
    message += md.render('```')

    message += md.render('## Input')
    message += md.render('```json')
    message += md.render(JSON.stringify(input))
    message += md.render('```')

    message += md.render('## Errors')

    for (const error of errors) {
        message += md.render(`- ${error}`)
    }

    return message
}

//================ FORMS ================

export const getFormValue = (form: FormDefinitionResponseBeta, input: string): string => {
    let value = ''
    if (form.formInput) {
        const i = form.formInput.find((x) => x.id === input) as any
        if (i && i.description) value = i.description
    }
    return value
}

export const buildReviewFromFormInstance = (instance: FormInstanceResponseBeta): string => {
    const account = (instance.formInput!.name as any).value
    const source = (instance.formInput!.source as any).value
    const url = instance.standAloneFormUrl
    const review = `${account} (${source}): [${url}]`

    return review
}

//================ SCHEMAS ================

export const stringifyScore = (score: Map<string, string>): string => {
    const keys = Array.from(score.keys())
    const str = keys.map((x) => `${x} (${score.get(x)})`).join(' ,')

    return str
}

export const stringifyIdentity = (identity: IdentityDocument, url: string): string => {
    const displayName = `${identity.displayName} **[${identity.attributes!.uid}](${url}/ui/a/admin/identities/${identity.id}/details/attributes)**)`

    return displayName
}
