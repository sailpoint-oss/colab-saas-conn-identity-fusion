import { logger } from '@sailpoint/connector-sdk'
import { Account } from 'sailpoint-api-client'
import velocityjs from 'velocityjs'
import { buildAccountAttributesObject, lm } from '.'
import { transliterate } from 'transliteration'
import { Config } from '../model/config'

export const buildUniqueID = async (
    account: Account,
    currentIDs: string[],
    config: Config,
    buildContext: boolean
): Promise<string> => {
    const c = 'buildUniqueID'

    let template = velocityjs.parse(config.uid_template)
    if (!template.find((x) => x.id === 'counter')) {
        template = velocityjs.parse(config.uid_template + '$counter')
    }
    const velocity = new velocityjs.Compile(template)

    let found = false
    let counter = 0
    let id = ''
    while (!found) {
        logger.debug(lm('Building context', c, 2))
        let context
        if (buildContext) {
            const attributes = buildAccountAttributesObject(account, config.merging_map)
            context = { ...account.attributes, ...attributes }
        } else {
            context = { ...account.attributes }
        }

        if (counter > 0) {
            const c = '0'.repeat(Math.max(0, config.uid_digits - counter.toString().length)) + counter
            context.counter = c
        } else {
            context.counter = ''
        }

        id = velocity.render(context)
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

// export const buildUniqueAccount = async (
//     account: Account,
//     status: string,
//     msg: string | undefined,
//     identities: IdentityDocument[],
//     currentIDs: string[],
//     config: Config
// ): Promise<Account> => {
//     const c = 'buildUniqueAccount'
//     logger.debug(lm(`Processing ${account.name} (${account.id})`, c, 1))
//     let uniqueID: string

//     uniqueID = await buildUniqueID(account, currentIDs, config)

//     if (status !== 'reviewer') {
//         uniqueID = await buildUniqueID(account, currentIDs, config)
//     } else {
//         logger.debug(lm(`Taking identity uid as unique ID`, c, 1))
//         const identity = identities.find((x) => x.id === account.identityId) as IdentityDocument
//         uniqueID = identity?.attributes!.uid
//     }

//     const uniqueAccount: Account = { ...account }
//     uniqueAccount.attributes!.uniqueID = uniqueID
//     uniqueAccount.attributes!.accounts = [account.id]
//     uniqueAccount.attributes!.status = [status]
//     uniqueAccount.attributes!.reviews = []

//     if (msg) {
//         const message = datedMessage(msg, account)
//         uniqueAccount.attributes!.history = [message]
//     }
//     return uniqueAccount
// }

// export const buildUniqueAccountFromID = async (
//     id: string,
//     schema: AccountSchema,
//     source: Source,
//     identities: IdentityDocument[],
//     config: Config,
//     client: SDKClient
// ): Promise<UniqueAccount> => {
//     const c = 'buildUniqueAccountFromID'
//     logger.debug(lm(`Fetching original account`, c, 1))
//     const account = await client.getAccountBySourceAndNativeIdentity(source.id!, id)
//     const sourceAccounts: Account[] = []
//     if (account) {
//         const identity = await client.getIdentity(account.identityId!)
//         const accounts = await client.getAccountsByIdentity(identity!.id!)
//         const correlatedAccounts = accounts
//             .filter((x) => config.sources.includes(x.sourceName!))
//             .map((x) => x.id as string)
//         account.attributes!.accounts = combineArrays(correlatedAccounts, account.attributes!.accounts)

//         for (const acc of account.attributes!.accounts) {
//             logger.debug(lm(`Looking for ${acc} account`, c, 1))
//             const response = await client.getAccount(acc)
//             if (response) {
//                 logger.debug(lm(`Found linked account ${response.name} (${response.sourceName})`, c, 1))
//                 sourceAccounts.push(response)
//             } else {
//                 logger.error(lm(`Unable to find account ID ${acc}`, c, 1))
//             }
//         }

//         const uniqueAccount = await refreshAccount(account, sourceAccounts, schema, identities, config, client)
//         return uniqueAccount
//     } else {
//         throw new ConnectorError('Account not found', ConnectorErrorType.NotFound)
//     }
// }
