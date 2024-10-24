import {
    ConnectorError,
    StdAccountDisableHandler,
    StdAccountDiscoverSchemaHandler,
    StdAccountEnableHandler,
    StdAccountListHandler,
    StdAccountReadHandler,
    StdEntitlementListHandler,
    StdEntitlementListOutput,
    StdTestConnectionHandler,
    createConnector,
    logger,
} from '@sailpoint/connector-sdk'
import { Account, IdentityDocument } from 'sailpoint-api-client'
import { Email } from './model/email'
import { datedMessage, getAccountFromIdentity, getFormValue, opLog } from './utils'

import { ContextHelper } from './contextHelper'
import { PROCESSINGWAIT } from './constants'
import { Config } from './model/config'
import { statuses } from './data/status'
import { Status } from './model/status'

// Connector must be exported as module property named connector
export const connector = async () => {
    const ctx = new ContextHelper()

    const fetchUniqueIDs = (config: Config) => {
        if (config.uid_scope === 'source') {
            logger.info('Compiling current IDs for source scope.')
            ctx.ids = ctx.accounts.map((x) => x.attributes.id)
        } else {
            logger.info('Compiling current IDs for tenant scope.')
            ctx.ids = ctx.identities.map((x) => x.attributes!.uid)
        }
    }

    //==============================================================================================================

    const stdTest: StdTestConnectionHandler = async (context, input, res) => {
        await ctx.init(true)
        const config = await ctx.getConfig()
        const source = ctx.getSource()
        const sources = ctx.getSources()
        const reviewers = ctx.getReviewerIDs()

        logger.info(config)

        if (!source) {
            throw new ConnectorError('Unable to connect to IdentityNow! Please check your configuration')
        }

        if (sources.length < config.sources.length) {
            throw new ConnectorError('Unable to find all sources. Please check your configuration')
        }

        if (reviewers.length === 0 && config.merging_reviewer) {
            throw new ConnectorError('Unable to find reviewer. Please check your configuration')
        }

        logger.info('Test successful!')
        res.send({})
    }

    const stdAccountList: StdAccountListHandler = async (context, input, res): Promise<void> => {
        const config = await ctx.getConfig()
        await opLog(config, input)

        if (config.reset) return

        //Keepalive
        const interval = setInterval(() => {
            res.keepAlive()
        }, PROCESSINGWAIT)

        //Compiling info
        logger.info('Loading data.')
        if (input.schema) {
            ctx.schema = input.schema
        }
        await ctx.init()
        const reviewerIDs = ctx.getReviewerIDs()
        // The set of all accounts already listed on some Identity Fusion account
        const processedAccounts = ctx.accounts.map((x) => x.attributes.accounts).flat(1)

        // The set of all accounts we need to normalize and evaluate
        let pendingAccounts: Account[]
        if (config.includeExisting) {
            logger.debug('Including existing identities.')
            pendingAccounts = ctx.authoritativeAccounts.filter((x) => !processedAccounts.includes(x.id!))
        } else {
            logger.debug('Excluding existing identities.')
            pendingAccounts = ctx.authoritativeAccounts
                .filter((x) => x.uncorrelated === true)
                .filter((x) => !processedAccounts.includes(x.id!))
        }

        const firstRun = ctx.accounts.length === 0

        fetchUniqueIDs(config)

        //PROCESS FORM INSTANCES
        logger.info('Processing existing forms.')
        for (const currentForm of ctx.forms) {
            let cancelled = true
            let finished = false
            const accountID = getFormValue(currentForm, 'account')
            const instances = firstRun ? [] : ctx.formInstances.filter((x) => x.formDefinitionId === currentForm.id)
            for (const currentFormInstance of instances) {
                logger.debug(`Processing form instance ${currentForm.name} (${currentFormInstance.id}).`)
                const formName = currentForm.name

                switch (currentFormInstance.state) {
                    case 'COMPLETED':
                        const { decision, account, message } = await ctx.processFormInstance(currentFormInstance)
                        logger.debug(`Result: ${message}.`)

                        const identityMatch = ctx.identities.find((x) => x.attributes!.uid === decision)

                        if (identityMatch) {
                            logger.debug(`Updating existing account for ${decision}.`)
                            const fusionAccount = ctx.accounts.find((x) => x.identityId === identityMatch.id) as Account
                            const uncorrelatedAccount = (await ctx.getAccount(accountID)) as Account
                            const msg = datedMessage(message, uncorrelatedAccount)
                            fusionAccount.attributes.accounts.push(account)
                            fusionAccount.attributes.history.push(msg)
                            fusionAccount.attributes.status.push('manual')
                        } else {
                            logger.debug(`Creating new unique account.`)
                            const pendingAccount = pendingAccounts.find((x) => x.id === account) as Account

                            try {
                                const fusionAccount = await ctx.buildUniqueAccount(
                                    pendingAccount,
                                    'authorized',
                                    message
                                )
                            } catch (e) {
                                ctx.handleError(e)
                            }
                        }
                        finished = true
                        ctx.deleteFormInstance(currentFormInstance)
                        break

                    case 'CANCELLED':
                        logger.debug(`${currentForm.name} (${currentFormInstance.id}) was cancelled.`)
                        ctx.deleteFormInstance(currentFormInstance)
                        break

                    default:
                        cancelled = false
                        logger.debug(`No decision made yet for ${formName} instance.`)
                }

                if (finished || cancelled) {
                    try {
                        logger.info(`Deleting form ${currentForm.name}.`)
                        await ctx.deleteForm(currentForm)
                    } catch (e) {
                        const error = `Error deleting form with ID ${currentForm.name}`
                        ctx.handleError(error)
                    }
                    break
                }
            }

            const index = pendingAccounts.findIndex((x) => x.id === accountID)
            if (index > -1) {
                pendingAccounts.splice(index, 1)
            }
        }

        //PROCESS EXISTING IDENTITIES/CREATE BASELINE
        if (config.includeExisting) {
            logger.info('Processing existing identities.')
            const currentIdentityIDs = ctx.accounts.map((x) => x.identityId)
            //Process correlated accounts not processed yet
            const correlatedAccounts = pendingAccounts.filter(
                (x) => x.uncorrelated === false && !currentIdentityIDs.includes(x.identityId)
            )
            for (const correlatedAccount of correlatedAccounts) {
                try {
                    const message = 'Baseline account'
                    const fusionAccount = await ctx.buildUniqueAccount(correlatedAccount, 'baseline', message)
                } catch (e) {
                    ctx.handleError(e)
                }
            }
            pendingAccounts = pendingAccounts.filter((x) => x.uncorrelated === true)
        }

        //CREATE BASELINE
        if (firstRun) {
            //First run
            logger.info('First run. Creating baseline.')
            for (const uncorrelatedAccount of pendingAccounts) {
                try {
                    const message = 'Baseline account'
                    const fusionAccount = await ctx.buildUniqueAccount(uncorrelatedAccount, 'baseline', message)
                } catch (e) {
                    ctx.handleError(e)
                }
            }
            pendingAccounts = []
        }

        //PROCESS UNCORRELATED ACCOUNTS (accounts not yet linked to a Fusion object)
        logger.info('Processing uncorrelated source accounts.')
        for (const uncorrelatedAccount of pendingAccounts) {
            try {
                const { processedAccount, uniqueForm } = await ctx.processUncorrelatedAccount(uncorrelatedAccount)
                if (processedAccount) {
                    const message = `No matching identity found`
                    const fusionAccount = await ctx.buildUniqueAccount(uncorrelatedAccount, 'unmatched', message)
                } else if (uniqueForm) {
                    if (reviewerIDs.length > 0) {
                        logger.debug(`Creating merging form`)
                        const form = await ctx.createUniqueForm(uniqueForm)
                        ctx.forms.push(form)
                    } else {
                        const message = `Potential matching identity found but no reviewers configured`
                        const fusionAccount = await ctx.buildUniqueAccount(uncorrelatedAccount, 'unmatched', message)
                    }
                }
            } catch (e) {
                ctx.handleError(e)
            }
        }

        //PROCESS FORMS
        logger.debug(`Checking form instances exist`)
        for (const form of ctx.forms) {
            for (const reviewerID of reviewerIDs) {
                const reviewer = ctx.identities.find((x) => x.id === reviewerID) as IdentityDocument
                let currentFormInstance = ctx.formInstances.find(
                    (x) => x.formDefinitionId === form.id && x.recipients!.find((y) => y.id === reviewerID)
                )
                if (!currentFormInstance) {
                    currentFormInstance = await ctx.createFormInstance(form, reviewerID)
                    logger.info(
                        `Form URL for ${ctx.identities.find((x) => x.id === reviewerID)?.attributes!.uid}: ${
                            currentFormInstance.standAloneFormUrl
                        }`
                    )
                    // Send notifications
                    logger.info(`Sending email notifications for ${form.name}`)
                    const email = new Email(reviewer, form.name!, currentFormInstance)
                    await ctx.sendEmail(email)
                }
            }
        }

        //PROCESS REVIEWERS
        logger.info('Processing reviewers.')
        for (const reviewerID of reviewerIDs) {
            const reviews = []
            for (const instance of ctx.formInstances) {
                if (instance.recipients!.find((x) => x.id === reviewerID)) {
                    const form = ctx.forms.find((x) => instance.formDefinitionId === x.id)
                    if (form) {
                        const account = instance.formInput!.name
                        const source = instance.formInput!.source
                        const url = instance.standAloneFormUrl
                        const review = `${account} (${source}): [${url}]`
                        reviews.push(review)
                    }
                }
            }

            const reviewer = ctx.identities.find((x) => x.id === reviewerID) as IdentityDocument
            let reviewerAccount = ctx.accounts.find((x) => x.identityId === reviewerID)

            if (reviewerAccount) {
                logger.debug(`${reviewer.attributes!.uid} reviewer account found.`)
                reviewerAccount.attributes!.reviews = reviews
            } else {
                try {
                    logger.debug(`${reviewer.attributes!.uid} reviewer account not found. Creating unique account.`)
                    const reviewerAccountID = getAccountFromIdentity(reviewer, reviewer.source!.id!)?.id as string
                    reviewerAccount = await ctx.getAccount(reviewerAccountID)
                    if (reviewerAccount) {
                        const message = 'Unique account for reviewer'
                        const fusionAccount = await ctx.buildUniqueAccount(reviewerAccount, 'reviewer', message)
                        fusionAccount.attributes!.reviews = reviews
                    } else {
                        throw new Error(`Unable to find base account for reviewer ID ${reviewerID}`)
                    }
                } catch (e) {
                    ctx.handleError(e)
                }
            }
        }

        //BUILD RESULTING ACCOUNTS
        logger.info('Building accounts.')

        const finalAccountsList = await ctx.getUniqueAccounts()

        logger.info('Sending accounts.')
        for (const account of finalAccountsList) {
            logger.info(account)
            res.send(account)
        }

        ctx.logErrors(context, input)

        clearInterval(interval)
    }

    const stdAccountRead: StdAccountReadHandler = async (context, input, res) => {
        const config = await ctx.getConfig()
        await opLog(config, input)

        logger.info(`Reading ${input.identity} account.`)

        if (config.reset) return

        await ctx.init(true)
        if (input.schema) {
            ctx.schema = input.schema
        }
        const fusionAccount = await ctx.buildUniqueAccountFromID(input.identity)
        logger.info(fusionAccount)
        res.send(fusionAccount)
    }

    const stdAccountEnable: StdAccountEnableHandler = async (context, input, res) => {
        const config = await ctx.getConfig()
        await opLog(config, input)

        logger.info(`Enabling ${input.identity} account.`)

        if (config.reset) return

        await ctx.init(true)
        if (input.schema) {
            ctx.schema = input.schema
        }

        //Keepalive
        const interval = setInterval(() => {
            res.keepAlive()
        }, PROCESSINGWAIT)

        const fusionAccount = ctx.buildUniqueAccountFromID(input.identity)
        fusionAccount
            .then((result) => {
                logger.info(result)
                res.send(result)
                clearInterval(interval) // Stops checking once the promise is resolved
            })
            .catch((error) => {
                logger.error(error)
                clearInterval(interval) // Stops checking if the promise is rejected
            })

        await fusionAccount
    }

    const stdAccountDisable: StdAccountDisableHandler = async (context, input, res) => {
        const config = await ctx.getConfig()
        await opLog(config, input)

        logger.info(`Disabling ${input.identity} account.`)

        if (config.reset) return

        await ctx.init()
        if (input.schema) {
            ctx.schema = input.schema
        }

        //Keepalive
        const interval = setInterval(() => {
            res.keepAlive()
        }, PROCESSINGWAIT)

        fetchUniqueIDs(config)
        const uniqueID = await ctx.buildUniqueID(input.identity)
        const account = ctx.buildUniqueAccountFromID(input.identity)
        account
            .then((result) => {
                result.disabled = true
                result.attributes.IIQDisabled = true
                result.attributes.id = uniqueID
                if (ctx.schema) {
                    result.identity = (
                        result.attributes[ctx.schema.identityAttribute]
                            ? result.attributes[ctx.schema.identityAttribute]
                            : result.attributes.uuid
                    ) as string
                    result.uuid = (
                        result.attributes[ctx.schema.displayAttribute]
                            ? (result.attributes[ctx.schema.displayAttribute] as string)
                            : result.attributes.uuid
                    ) as string
                } else {
                    result.identity = result.attributes.uuid as string
                    result.uuid = result.attributes.uuid as string
                }
                logger.info(result)
                res.send(result)
                clearInterval(interval) // Stops checking once the promise is resolved
            })
            .catch((error) => {
                logger.error(error)
                clearInterval(interval) // Stops checking if the promise is rejected
            })

        await account
    }

    const stdEntitlementList: StdEntitlementListHandler = async (context, input, res) => {
        const c = 'stdEntitlementList'
        const errors: string[] = []

        try {
            logger.info(input)
            let entitlements: StdEntitlementListOutput[]
            switch (input.type) {
                case 'status':
                    entitlements = statuses.map((x) => new Status(x))
                    break

                default:
                    const message = `Unsupported entitlement type ${input.type}`
                    throw new ConnectorError(message)
            }
            for (const e of entitlements) {
                logger.info(e)
                res.send(e)
            }
        } catch (e) {
            if (e instanceof Error) {
                logger.error(e.message)
                errors.push(e.message)
            }
        }

        ctx.logErrors(context, input)
    }

    const stdAccountDiscoverSchema: StdAccountDiscoverSchemaHandler = async (context, input, res) => {
        const config = await ctx.getConfig()
        await opLog(config, input)
        logger.info('Building dynamic schema.')

        await ctx.init(true)
        const schema = await ctx.getSchema()

        logger.info(schema)
        res.send(schema)
    }

    return createConnector()
        .stdTestConnection(stdTest)
        .stdAccountList(stdAccountList)
        .stdAccountRead(stdAccountRead)
        .stdAccountEnable(stdAccountEnable)
        .stdAccountDisable(stdAccountDisable)
        .stdEntitlementList(stdEntitlementList)
        .stdAccountDiscoverSchema(stdAccountDiscoverSchema)
}
