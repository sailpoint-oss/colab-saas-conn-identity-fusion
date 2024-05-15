import {
    Account,
    AttributeDefinition,
    BaseAccount,
    FormDefinitionInputBeta,
    FormDefinitionResponseBeta,
    FormInstanceResponseBeta,
    IdentityBeta,
    IdentityDocument,
    OwnerDto,
    Schema,
    Source,
    WorkflowBeta,
} from 'sailpoint-api-client'
import { SDKClient } from '../sdk-client'
import { EmailWorkflow } from '../model/emailWorkflow'
import { AccountSchema, Context, SchemaAttribute, logger } from '@sailpoint/connector-sdk'
import { Email, ErrorEmail } from '../model/email'
import { Config } from '../model/config'
import {
    FORM_NAME,
    IDENTITYNOTFOUNDRETRIES,
    IDENTITYNOTFOUNDWAIT,
    MSDAY,
    PADDING,
    reservedAttributes,
} from '../constants'
import { UniqueForm } from '../model/form'
import { findIdenticalMatch, findSimilarMatches } from './matching'
import { AxiosError } from 'axios'
import { UniqueAccount } from '../model/account'

import MarkdownIt from 'markdown-it'

export const md = MarkdownIt({
    breaks: true,
    xhtmlOut: true,
})

//================ MISC ================
export const sleep = (ms: number) => {
    return new Promise((resolve) => setTimeout(resolve, ms))
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

    return [...set].map((x) => `[${x}]`).join(' ')
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

export const datedMessage = (message: string, account: Account): string => {
    const now = new Date().toISOString().split('T')[0]

    return `[${now}] ${message} [${account.name} (${account.sourceName})]`
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

export const opLog = async (config: any, input: any) => {
    logger.info('Input:')
    logger.info(input)
    logger.debug('Config:')
    logger.debug(config)
}

export const handleError = (error: any, errors: string[]) => {
    let message = error
    if (error instanceof Error) {
        let message = error.message
        if (error instanceof AxiosError) {
            const details = error.response!.data.messages.find((x: { locale: string }) => x.locale === 'en-US')
            if (details) {
                message = message + '\n' + details.text
            }
        }
    }
    logger.error(message)
    logger.error(error)
    errors.push(message)
}

//================ SOURCES ================
export const getOwnerFromSource = (source: Source): OwnerDto => {
    return {
        type: 'IDENTITY',
        id: source.owner.id,
    }
}

export const getCurrentSource = async (client: SDKClient, id: string): Promise<Source | undefined> => {
    const c = 'getCurrentSource'
    logger.debug(lm('Fetching sources.', c, 1))
    const sources = await client.listSources()
    logger.debug(lm(`Looking for connector instance id ${id}.`, c, 1))
    const source = sources.find((x) => (x.connectorAttributes as any).spConnectorInstanceId === id)

    return source
}

//================ IDENTITIES ================
export const getAccountByIdentity = (identity: IdentityDocument, sourceID: string): BaseAccount | undefined => {
    return identity.accounts!.find((x) => x.source!.id === sourceID)
}

export const getIdentities = async (
    client: SDKClient,
    source: Source
): Promise<{ [key: string]: IdentityDocument[] }> => {
    const identities = (await client.listIdentities()).filter((x) => !x.protected)
    const processedIdentities: IdentityDocument[] = []
    const unprocessedIdentities: IdentityDocument[] = []
    for (const identity of identities) {
        if (identity.accounts!.find((x) => x.source!.id === source.id)) {
            processedIdentities.push(identity)
        } else if (identity.attributes!.cloudAuthoritativeSource) {
            unprocessedIdentities.push(identity)
        }
    }

    return { identities, processedIdentities, unprocessedIdentities }
}

export const buildReviewersMap = async (
    client: SDKClient,
    config: Config,
    currentSource: Source,
    sources: Source[]
): Promise<Map<string, string[]>> => {
    const reviewersMap = new Map<string, string[]>()
    let defaultReviewerIDs: string[] = []
    if (config.merging_reviewerIsSourceOwner) {
        defaultReviewerIDs = await getReviewerIDs(client, currentSource)
    }

    for (const source of sources) {
        if (config.merging_reviewerIsSourceOwner) {
            const reviewerIDs = await getReviewerIDs(client, source)
            reviewersMap.set(source.name, reviewerIDs)
        } else {
            reviewersMap.set(source.name, defaultReviewerIDs)
        }
    }

    return reviewersMap
}

export const getReviewerIDs = async (client: SDKClient, source: Source): Promise<string[]> => {
    const c = 'getReviewerIDs'
    logger.debug(lm(`Fetching reviewers for ${source.name}`, c, 1))
    let reviewers: string[] = []

    if (source.managementWorkgroup) {
        logger.debug(lm(`Reviewer is ${source.managementWorkgroup.name} workgroup`, c, 1))
        const workgroups = await client.listWorkgroups()
        const workgroup = workgroups.find((x) => x.id === source.managementWorkgroup!.id)
        if (workgroup) {
            logger.debug(lm('Workgroup found', c, 1))
            const members = await client.listWorkgroupMembers(workgroup.id!)
            reviewers = members.map((x) => x.id!)
        }
    } else if (source.owner || reviewers.length === 0) {
        logger.debug(lm('Reviewer is the owner', c, 1))
        const reviewerIdentity = await client.getIdentityByUID(source.owner.name!)
        if (reviewerIdentity) {
            logger.debug(lm('Reviewer found', c, 1))
            reviewers.push(reviewerIdentity.id!)
        } else {
            logger.error(lm(`Reviewer not found ${source.owner.name}`, c, 1))
        }
    } else {
        logger.warn(lm(`No reviewer provided. Merging forms will not be processed.`, c, 1))
    }

    return reviewers
}

//================ ACCOUNTS ================

export const updateAccountLinks = (account: Account, identities: IdentityDocument[], sourceNames: string[]) => {
    if (account.uncorrelated === false && account.disabled === false) {
        const identity = identities.find((x) => x.id === account.identityId)
        const correlatedAccounts = identity?.accounts
            ?.filter((x) => sourceNames.includes(x.source!.name!))
            .map((x) => x.id as string)
        // Removing previously existing authoritative accounts and leaving only existing ones
        account.attributes.accounts = combineArrays(correlatedAccounts, account.attributes.accounts)
    }
}

export const processUncorrelatedAccount = async (
    uncorrelatedAccount: Account,
    currentAccounts: Account[],
    currentIdentities: IdentityDocument[],
    source: Source,
    config: Config,
    merge: boolean
): Promise<{ processedAccount: Account | undefined; uniqueForm: UniqueForm | undefined }> => {
    // Check if identical match exists
    const c = 'processUncorrelatedAccount'

    let processedAccount: Account | undefined
    let uniqueForm: UniqueForm | undefined
    logger.debug(lm(`Checking identical match for ${uncorrelatedAccount.name} (${uncorrelatedAccount.id}).`, c, 1))
    const normalizedAccount = normalizeAccountAttributes(uncorrelatedAccount, config.merging_map)
    const identicalMatch = findIdenticalMatch(normalizedAccount, currentIdentities, config.merging_map)
    if (identicalMatch) {
        logger.debug(lm(`Identical match found.`, c, 1))
        const account = currentAccounts.find((x) => x.identityId === identicalMatch.id) as Account
        const message = datedMessage('Identical match found.', uncorrelatedAccount)
        account.attributes.status.push('auto')
        account.attributes.accounts.push(uncorrelatedAccount.id)
        account.attributes.history.push(message)
        // Check if similar match exists
    } else {
        let similarMatches: {
            identity: IdentityDocument
            score: string
        }[] = []
        if (merge) {
            logger.debug(
                lm(`Checking similar matches for ${uncorrelatedAccount.name} (${uncorrelatedAccount.id})`, c, 1)
            )
            similarMatches = findSimilarMatches(
                uncorrelatedAccount,
                currentIdentities,
                config.merging_map,
                config.merging_score!
            )
        }

        if (similarMatches.length > 0) {
            logger.debug(lm(`Similar matches found`, c, 1))
            const formName = getFormName(source.name, uncorrelatedAccount)
            const formOwner = { id: source.owner.id, type: source.owner.type }
            const accountAttributes = buildAccountAttributesObject(uncorrelatedAccount, config.merging_map)
            uncorrelatedAccount.attributes = { ...uncorrelatedAccount.attributes, ...accountAttributes }
            uncorrelatedAccount = normalizeAccountAttributes(uncorrelatedAccount, config.merging_map)
            uniqueForm = new UniqueForm(
                formName,
                formOwner,
                uncorrelatedAccount,
                similarMatches,
                config.merging_attributes
            )
        } else {
            // No matching existing identity found
            logger.debug(lm(`No matching identity found. Creating new unique account.`, c, 1))
            processedAccount = uncorrelatedAccount
        }
    }

    return { processedAccount, uniqueForm }
}

export const refreshAccount = async (
    account: Account,
    sourceAccounts: Account[],
    schema: AccountSchema,
    identities: IdentityDocument[],
    config: Config,
    client: SDKClient
): Promise<UniqueAccount> => {
    const c = 'refreshAccount'

    logger.debug(lm(`Refreshing ${account.attributes.uniqueID} account`, c, 1))
    const attributes = account.attributes

    for (const attrDef of schema.attributes) {
        if (!reservedAttributes.includes(attrDef.name)) {
            const attrConf = config.merging_map.find((x) => x.identity === attrDef.name)
            const attributeMerge = attrConf?.attributeMerge || config.attributeMerge
            let firstSource = true
            for (const sourceAccount of sourceAccounts) {
                let value: any
                if (attrConf) {
                    for (const accountAttr of attrConf.account) {
                        if (!sourceAccount.attributes) logger.warn(sourceAccount)
                        value = sourceAccount.attributes[accountAttr]
                        if (value) break
                    }
                } else {
                    value = sourceAccount.attributes[attrDef.name]
                }
                if (value) {
                    let lst: string[]
                    switch (attributeMerge) {
                        case 'multi':
                            if (firstSource) {
                                lst = [].concat(value)
                            } else {
                                let previousList: string[] = [].concat(attributes[attrDef.name])
                                if (previousList.length === 0) {
                                    lst = [].concat(value)
                                } else if (previousList.length > 1) {
                                    lst = [...previousList, value]
                                } else {
                                    lst = [...attrSplit(previousList[0]), value]
                                }
                            }
                            attributes[attrDef.name] = Array.from(new Set(lst))
                            break

                        case 'concatenate':
                            if (firstSource) {
                                lst = [].concat(value)
                            } else {
                                lst = []
                                let previousList: string[] = [].concat(attributes[attrDef.name])
                                for (const item of previousList) {
                                    lst = lst.concat(attrSplit(item))
                                }
                                lst = lst.concat(attrSplit(value))
                            }
                            attributes[attrDef.name] = attrConcat(lst)
                            break
                        case 'first':
                            if (firstSource) {
                                attributes[attrDef.name] = value
                            }
                            break

                        case 'source':
                            const source = attrConf?.source
                            if (sourceAccount.sourceName === source) {
                                attributes[attrDef.name] = value
                            }
                            break
                        default:
                            break
                    }
                }
                firstSource = false
            }
        }
    }

    attributes.status = Array.from(new Set(attributes.status))

    if (account.uncorrelated) {
        logger.debug(lm(`New account. Needs to be enabled.`, c, 2))
    } else {
        logger.debug(lm(`Existing account. Enforcing defined correlation.`, c, 1))
        let identity: IdentityDocument | IdentityBeta | undefined
        let accounts: Account[] | BaseAccount[]
        identity = identities.find((x) => x.id === account.identityId) as IdentityDocument
        if (!identity) {
            let count = 0
            let wait = IDENTITYNOTFOUNDWAIT
            while (!identity) {
                identity = await client.getIdentity(account.identityId!)
                if (!identity) {
                    if (++count > IDENTITYNOTFOUNDRETRIES)
                        throw new Error(
                            `Identity ${account.identityId} for account ${account.nativeIdentity} not found`
                        )

                    logger.warn(lm(`Identity ID ${account.identityId} not found. Re-trying...`, c, 1))
                    await sleep(wait)
                    wait = wait + IDENTITYNOTFOUNDWAIT
                }
            }
            accounts = await client.getAccountsByIdentity(identity!.id!)
        } else {
            accounts = (identity as IdentityDocument).accounts!
        }

        for (const acc of account.attributes.accounts as string[]) {
            const uid: string = (identity.attributes as any).uid
            try {
                if (!accounts.find((x) => x.id === acc)) {
                    logger.debug(lm(`Correlating ${acc} account with ${uid}.`, c, 1))
                    const response = await client.correlateAccount(identity?.id as string, acc)
                }
            } catch (e) {
                logger.error(lm(`Failed to correlate ${acc} account with ${uid}.`, c, 1))
                account.attributes.accounts = account.attributes.accounts.filter((x: string) => x !== acc)
            }
        }
    }

    const uniqueAccount = new UniqueAccount(account, schema)

    return uniqueAccount
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
        if (!normalizedAccount.attributes[attribute.identity]) {
            for (const accAttribute of attribute.account) {
                if (normalizedAccount.attributes[accAttribute]) {
                    normalizedAccount.attributes[attribute.identity] = normalizedAccount.attributes[accAttribute]
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
    }[]
): {
    [key: string]: any
} => {
    const attributeObject: {
        [key: string]: any
    } = {}

    for (const { identity: key, account: values } of mergingMap.filter((x) => x.uidOnly === false)) {
        for (const value of values.reverse()) {
            const v = account.attributes[value]
            if (v) {
                attributeObject[key] = account.attributes[value]
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
export const getEmailWorkflow = async (
    client: SDKClient,
    name: string,
    owner: OwnerDto
): Promise<WorkflowBeta | undefined> => {
    const c = 'getEmailWorkflow'
    logger.debug(lm('Fetching workflows', c, 1))
    const workflows = await client.listWorkflows()
    let workflow = workflows.find((x) => x.name === name)
    if (workflow) {
        logger.debug(lm('Workflow found', c, 1))
    } else {
        logger.debug(lm('Creating workflow', c, 1))
        const emailWorkflow = new EmailWorkflow(name, owner)
        workflow = await client.createWorkflow(emailWorkflow)
    }

    return workflow
}

export const sendEmail = async (email: Email, workflow: WorkflowBeta, client: SDKClient) => {
    await client.testWorkflow(workflow.id!, email)
}

export const logErrors = async (
    context: Context,
    input: any,
    errors: string[],
    source: Source,
    workflow: WorkflowBeta,
    client: SDKClient
) => {
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

    const ownerID = source.owner.id as string
    const recipient = await client.getIdentityBySearch(ownerID)
    const email = new ErrorEmail(source, recipient!.email!, message)

    await sendEmail(email, workflow, client)
}

//================ FORMS ================
export const processFormInstance = async (
    client: SDKClient,
    formInstance: FormInstanceResponseBeta
): Promise<{ decision: string; account: string; message: string }> => {
    const c = 'processFormInstance'
    const now = new Date().toISOString()
    let message = ''
    const decision = formInstance.formData!['identities'].toString()
    const account = (formInstance.formInput!['account'] as any).value
    const reviewerIdentity = await client.getIdentityBySearch(formInstance.recipients![0].id!)
    const reviewerName = reviewerIdentity
        ? reviewerIdentity.displayName
            ? reviewerIdentity.displayName
            : reviewerIdentity.name
        : formInstance.recipients![0].id!

    if (decision === 'This is a new identity') {
        message = `New identity approved by ${reviewerName}`
    } else {
        const source = (formInstance.formInput!.source as any).value
        message = `Assignment approved by ${reviewerName}`
    }

    return { decision, account, message }
}

export const getFormName = (sourceName: string, account?: Account): string => {
    let name: string
    if (account) {
        name = `${FORM_NAME} (${sourceName}) - ${account.name} (${account.id})`
    } else {
        name = `${FORM_NAME} (${sourceName})`
    }
    return name
}

export const getFormValue = (form: FormDefinitionResponseBeta, input: string): string => {
    return form.formInput?.find((x) => x.id === input)?.description!
}

export const buildReviewFromFormInstance = (instance: FormInstanceResponseBeta): string => {
    const account = (instance.formInput!.name as any).value
    const source = (instance.formInput!.source as any).value
    const url = instance.standAloneFormUrl
    const review = `${account} (${source}): [${url}]`

    return review
}

//================ SCHEMAS ================
export const buildDynamicSchema = async (
    sources: Source[],
    config: Config,
    client: SDKClient
): Promise<AccountSchema> => {
    const c = 'buildDynamicSchema'
    logger.debug(lm('Fetching sources.', c, 1))
    const schemas: Schema[] = []
    logger.debug(lm('Fetching schemas.', c, 1))
    for (const source of sources) {
        const sourceSchemas = await client.listSourceSchemas(source.id!)
        schemas.push(sourceSchemas.find((x) => x.name === 'account') as Schema)
    }

    logger.debug(lm('Compiling attributes.', c, 1))
    let combinedAttributes: Map<string, AttributeDefinition> = new Map()
    for (const schema of schemas.reverse()) {
        schema.attributes?.forEach((x) => combinedAttributes.set(x.name!, x))
    }

    logger.debug(lm('Defining static attributes.', c, 1))
    const attributes: SchemaAttribute[] = [
        {
            name: 'uniqueID',
            description: 'Unique ID',
            type: 'string',
            required: true,
        },
        {
            name: 'uuid',
            description: 'UUID',
            type: 'string',
            required: true,
        },
        {
            name: 'history',
            description: 'History',
            type: 'string',
            multi: true,
        },
        {
            name: 'status',
            description: 'Status',
            type: 'string',
            multi: true,
            entitlement: true,
            managed: false,
            schemaObjectType: 'status',
        },
        {
            name: 'accounts',
            description: 'Account IDs',
            type: 'string',
            multi: true,
            entitlement: false,
        },
        {
            name: 'reviews',
            description: 'Reviews',
            type: 'string',
            multi: true,
            entitlement: false,
        },
    ]

    logger.debug(lm('Processing attribute merge mapping.', c, 1))
    for (const mergingConf of config.merging_map) {
        const description = mergingConf.source ? mergingConf.source : mergingConf.identity
        const attribute: any = {
            name: mergingConf.identity,
            description,
            type: 'string',
        }

        switch (mergingConf.attributeMerge) {
            case 'multi':
                attribute.multi = true
                attribute.entitlement = true
                break

            case 'concatenate':
                attribute.multi = false
                break

            default:
                break
        }

        attributes.push(attribute)
    }

    logger.debug(lm('Processing existing attributes.', c, 1))
    for (const attribute of combinedAttributes.values()) {
        if (!attributes.find((x) => x.name === attribute.name!)) {
            const mergingConf = config.merging_map.find((x) => x.attributeMerge?.includes(attribute.name!))
            let attributeMerge: string
            if (mergingConf?.attributeMerge) {
                attributeMerge = mergingConf.attributeMerge
            } else {
                attributeMerge = config.attributeMerge
            }
            const matchingSchemas = schemas.filter((x) => x.attributes?.find((y) => y.name === attribute.name))
            switch (attributeMerge) {
                case 'multi':
                    if (matchingSchemas.length > 1) {
                        attribute.isMulti = true
                        attribute.type = 'STRING'
                    }
                    break

                case 'concatenate':
                    attribute.isMulti = false
                    attribute.type = 'STRING'
                    break

                default:
                    break
            }

            if (attribute.isMulti) {
                attribute.isEntitlement = true
                attribute.isGroup = false
            }

            const description = (
                attribute.description === null || attribute.description === '' ? attribute.name : attribute.description
            ) as string
            const schemaAttribute: SchemaAttribute = {
                name: attribute.name!,
                description,
                type: attribute.type ? attribute.type.toLowerCase() : 'string',
                multi: attribute.isMulti,
                managed: false,
                entitlement: attribute.isEntitlement,
            }

            attributes.push(schemaAttribute)
        }
    }

    const schema: any = {
        attributes,
        displayAttribute: 'uuid',
        identityAttribute: 'uuid',
    }

    return schema
}
