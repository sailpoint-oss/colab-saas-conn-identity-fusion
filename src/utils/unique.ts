import { AccountSchema, ConnectorError, ConnectorErrorType, logger } from '@sailpoint/connector-sdk'
import { Account, IdentityDocument, Source } from 'sailpoint-api-client'
import velocityjs from 'velocityjs'
import { buildAccountAttributesObject, combineArrays, datedMessage, lm, refreshAccount } from '.'
import { transliterate } from 'transliteration'
import { Config } from '../model/config'
import { UniqueAccount } from '../model/account'
import { SDKClient } from '../sdk-client'

export const buildUniqueID = async (account: Account, currentIDs: string[], config: Config): Promise<string> => {
    const c = 'buildUniqueID'

    let parsedTemplateAst = velocityjs.parse(config.uid_template)
    if (!parsedTemplateAst.find((x) => x.id === 'counter')) {
        parsedTemplateAst = velocityjs.parse(config.uid_template + '$counter')
    }
    const velocity = new velocityjs.Compile(parsedTemplateAst)

    let found = false
    let counter = 0
    let id = ''
    while (!found) {
        logger.debug(lm('Building context', c, 2))
        let velocityContext = buildAccountAttributesObject(account, config.merging_map)
        velocityContext = { ...account.attributes, ...velocityContext }
        if (counter > 0) {
            const c = '0'.repeat(Math.max(0, config.uid_digits - counter.toString().length)) + counter
            velocityContext.counter = c
        } else {
            velocityContext.counter = ''
        }

        id = velocity.render(velocityContext)
        logger.debug(lm(`Template render result: ${id}`, c, 2))
        if (id.length === 0) {
            throw new Error('No value returned by template')
        }

        if (config.uid_normalize) {
            id = transliterate(id)
            id = id.replace(/'/g, '')
        }

        if (config.uid_spaces) {
            id = id.replace(/\s/g, '')
        }

        switch (config.uid_case) {
            case 'lower':
                id = id.toLowerCase()
                break
            case 'upper':
                id = id.toUpperCase()
                break
            default:
                break
        }

        if (currentIDs.includes(id!)) {
            counter++
            logger.debug(`Duplicate ID found for ${id}`)
        } else {
            found = true
        }
    }

    logger.debug(lm(`Final ID: ${id}`, c, 2))
    return id
}

export const buildUniqueAccount = async (
    account: Account,
    status: string,
    msg: string | undefined,
    identities: IdentityDocument[],
    currentIDs: string[],
    config: Config
): Promise<Account> => {
    const c = 'buildUniqueAccount'
    logger.debug(lm(`Processing ${account.name} (${account.id})`, c, 1))
    let uniqueID: string

    if (config.uid_scope === 'source' && status !== 'reviewer') {
        uniqueID = await buildUniqueID(account, currentIDs, config)
    } else if (account.uncorrelated && status !== 'reviewer') {
        uniqueID = await buildUniqueID(account, currentIDs, config)
    } else {
        logger.debug(lm(`Taking identity uid as unique ID`, c, 1))
        const identity = identities.find((x) => x.id === account.identityId) as IdentityDocument
        uniqueID = identity?.attributes!.uid
    }

    const uniqueAccount: Account = { ...account }
    uniqueAccount.attributes.id = uniqueID
    uniqueAccount.attributes.accounts = [account.id]
    uniqueAccount.attributes.status = [status]
    uniqueAccount.attributes.reviews = []

    if (msg) {
        const message = datedMessage(msg, account)
        uniqueAccount.attributes.history = [message]
    }
    return uniqueAccount
}

export const buildUniqueAccountFromID = async (
    nativeIdentity: string,
    schema: AccountSchema,
    source: Source,
    identities: IdentityDocument[],
    config: Config,
    client: SDKClient
): Promise<UniqueAccount> => {
    const c = 'buildUniqueAccountFromID'
    logger.debug(lm(`Fetching original account`, c, 1))
    const fusionAccount = await client.getAccountBySourceAndNativeIdentity(source.id!, nativeIdentity)
    const sourceAccounts: Account[] = []
    if (fusionAccount) {
        const identity = await client.getIdentity(fusionAccount.identityId!)
        const accounts = await client.getAccountsByIdentity(identity!.id!)
        const correlatedAccounts = accounts
            .filter((acct) => config.sources.includes(acct.sourceName!))
            .map((acct) => acct.id as string)
        fusionAccount.attributes.accounts = combineArrays(correlatedAccounts, fusionAccount.attributes.accounts)

        for (const acc of fusionAccount.attributes.accounts) {
            logger.debug(lm(`Looking for ${acc} account`, c, 1))
            const response = await client.getAccount(acc)
            if (response) {
                logger.debug(lm(`Found linked account ${response.name} (${response.sourceName})`, c, 1))
                sourceAccounts.push(response)
            } else {
                logger.error(lm(`Unable to find account ID ${acc}`, c, 1))
            }
        }

        const uniqueAccount = await refreshAccount(fusionAccount, sourceAccounts, schema, identities, config, client)
        return uniqueAccount
    } else {
        throw new ConnectorError('Account not found', ConnectorErrorType.NotFound)
    }
}
