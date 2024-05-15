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
import { Account, FormDefinitionInputBeta, IdentityDocument } from 'sailpoint-api-client'
import { Email } from './model/email'
import { buildReviewFromFormInstance, datedMessage, getAccountByIdentity, getFormValue, opLog } from './utils'

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
            ctx.ids = ctx.accounts.map((x) => x.attributes.uniqueID)
        } else {
            logger.info('Compiling current IDs for tenant scope.')
            ctx.ids = ctx.identities.map((x) => x.attributes!.uid)
        }
    }

    //==============================================================================================================

    //TODO improve
    const stdTest: StdTestConnectionHandler = async (context, input, res) => {
        await ctx.init(true)
        const config = await ctx.getConfig()
        const source = ctx.getSource()
        const sources = ctx.getSources()

        logger.info(config)

        if (!source) {
            throw new ConnectorError('Unable to connect to IdentityNow! Please check your configuration')
        }

        if (sources.length < config.sources.length) {
            throw new ConnectorError('Unable to find all sources. Please check your configuration')
        }

        if (config.merging_isEnabled) {
            const reviewers = ctx.getAllReviewerIDs()
            if (reviewers.length === 0) {
                throw new ConnectorError('Unable to find reviewer. Please check your configuration')
            }
        }

        logger.info('Test successful!')
        res.send({})
    }

    const stdAccountList: StdAccountListHandler = async (context, input, res): Promise<void> => {
        //Keepalive
        const interval = setInterval(() => {
            res.keepAlive()
        }, PROCESSINGWAIT)

        try {
            const config = await ctx.getConfig()
            await opLog(config, input)

            if (config.reset) return

            //Compiling info
            logger.info('Loading data.')
            if (input.schema) {
                ctx.schema = input.schema
            }
            await ctx.init()
            const processedAccounts = ctx.accounts.map((x) => x.attributes.accounts).flat()
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

            if (await ctx.isMergingEnabled()) {
                //PROCESS FORM INSTANCES
                logger.info('Processing existing forms.')
                const forms = await ctx.getForms()
                forms: for (const currentForm of forms) {
                    let cancelled = true
                    let finished = false
                    const accountID = getFormValue(currentForm, 'account')
                    const instances = firstRun ? [] : ctx.getFormInstancesByForm(currentForm)
                    formInstances: for (const currentFormInstance of instances) {
                        logger.debug(`Processing form instance ${currentForm.name} (${currentFormInstance.id}).`)
                        const formName = currentForm.name

                        switch (currentFormInstance.state) {
                            case 'COMPLETED':
                                const { decision, account, message } =
                                    await ctx.processFormInstance(currentFormInstance)
                                logger.debug(`Result: ${message}.`)

                                const identityMatch = ctx.identities.find((x) => x.attributes!.uid === decision)

                                if (identityMatch) {
                                    logger.debug(`Updating existing account for ${decision}.`)
                                    const uniqueAccount = ctx.accounts.find(
                                        (x) => x.identityId === identityMatch.id
                                    ) as Account
                                    const uncorrelatedAccount = (await ctx.getAccount(accountID)) as Account
                                    const msg = datedMessage(message, uncorrelatedAccount)
                                    uniqueAccount.attributes.accounts.push(account)
                                    uniqueAccount.attributes.history.push(msg)
                                    uniqueAccount.attributes.status.push('manual')
                                } else {
                                    logger.debug(`Creating new unique account.`)
                                    const pendingAccount = pendingAccounts.find((x) => x.id === account) as Account

                                    try {
                                        const uniqueAccount = await ctx.buildUniqueAccount(
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
                                break formInstances

                            case 'CANCELLED':
                                logger.debug(`${currentForm.name} (${currentFormInstance.id}) was cancelled.`)
                                ctx.deleteFormInstance(currentFormInstance)

                            default:
                                cancelled = false
                                logger.debug(`No decision made yet for ${formName} instance.`)
                        }
                    }

                    const index = pendingAccounts.findIndex((x) => x.id === accountID)
                    if (index > -1) {
                        pendingAccounts.splice(index, 1)
                    }
                    if (finished || cancelled) {
                        try {
                            logger.info(`Deleting form ${currentForm.name}.`)
                            await ctx.deleteForm(currentForm)
                        } catch (e) {
                            const error = `Error deleting form with ID ${currentForm.name}`
                            ctx.handleError(error)
                        }
                    }
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
                        const uniqueAccount = await ctx.buildUniqueAccount(correlatedAccount, 'baseline', message)
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
                        const uniqueAccount = await ctx.buildUniqueAccount(uncorrelatedAccount, 'baseline', message)
                    } catch (e) {
                        ctx.handleError(e)
                    }
                }
                pendingAccounts = []
            }

            //PROCESS UNCORRELATED ACCOUNTS
            logger.info('Processing uncorrelated accounts.')
            for (const uncorrelatedAccount of pendingAccounts) {
                try {
                    const { processedAccount, uniqueForm } = await ctx.processUncorrelatedAccount(uncorrelatedAccount)
                    if (processedAccount) {
                        const message = `No matching identity found`
                        const uniqueAccount = await ctx.buildUniqueAccount(uncorrelatedAccount, 'unmatched', message)
                    } else if (uniqueForm) {
                        if (await ctx.isMergingEnabled()) {
                            logger.debug(`Creating merging form`)
                            const form = await ctx.createUniqueForm(uniqueForm)
                            ctx.forms.push(form)
                        } else {
                            const message = `Potential matching identity found but no reviewers configured`
                            const uniqueAccount = await ctx.buildUniqueAccount(
                                uncorrelatedAccount,
                                'unmatched',
                                message
                            )
                        }
                    }
                } catch (e) {
                    ctx.handleError(e)
                }
            }

            if (await ctx.isMergingEnabled()) {
                //PROCESS FORMS
                const forms = await ctx.getForms()
                logger.debug(`Checking form instances exist`)
                for (const form of forms) {
                    const sourceName = getFormValue(form, 'source')
                    const reviewerIDs = ctx.getReviewerIDs(sourceName)

                    for (const reviewerID of reviewerIDs) {
                        const reviewer = ctx.getIdentityById(reviewerID)

                        if (reviewer) {
                            let currentFormInstance = ctx.getFormInstanceByReviewerID(form, reviewerID)

                            if (!currentFormInstance) {
                                currentFormInstance = await ctx.createFormInstance(form, reviewerID)
                                logger.info(
                                    `Form URL for ${reviewer.attributes!.uid}: ${currentFormInstance.standAloneFormUrl}`
                                )
                                // Send notifications
                                logger.info(`Sending email notifications for ${form.name}`)
                                const email = new Email(reviewer, form.name!, currentFormInstance)
                                await ctx.sendEmail(email)
                            }
                        } else {
                            ctx.deleteReviewerID(reviewerID, sourceName)
                            const error = `Reviewer ID ${reviewerID} was not found. Check your governance group for orphan members`
                            ctx.handleError(error)
                        }
                    }
                }

                //PROCESS REVIEWERS
                logger.info('Processing reviewers.')
                const reviewerIDs = ctx.getAllReviewerIDs()
                for (const reviewerID of reviewerIDs) {
                    const reviews = []
                    for (const instance of ctx.getFormInstancesByReviewerID(reviewerID)) {
                        const form = ctx.getFormByID(instance.formDefinitionId!)
                        if (form) {
                            const review = buildReviewFromFormInstance(instance)
                            reviews.push(review)
                        }
                    }

                    const reviewer = ctx.getIdentityById(reviewerID)!
                    let reviewerAccount = ctx.getIdentityAccount(reviewer)

                    if (reviewer) {
                        if (reviewerAccount) {
                            logger.debug(`${reviewer.attributes!.uid} reviewer account found.`)
                            reviewerAccount.attributes!.reviews = reviews
                        } else {
                            try {
                                logger.debug(
                                    `${reviewer.attributes!.uid} reviewer account not found. Creating unique account.`
                                )
                                const reviewerAccountID = getAccountByIdentity(reviewer, reviewer.source!.id!)?.id!
                                reviewerAccount = await ctx.getAccount(reviewerAccountID)
                                if (reviewerAccount) {
                                    const message = 'Unique account for reviewer'
                                    const uniqueAccount = await ctx.buildUniqueAccount(
                                        reviewerAccount,
                                        'reviewer',
                                        message
                                    )
                                    uniqueAccount.attributes!.reviews = reviews
                                } else {
                                    throw new Error(`Unable to find base account for reviewer ID ${reviewerID}`)
                                }
                            } catch (e) {
                                ctx.handleError(e)
                            }
                        }
                    } else {
                        const error = `Reviewer ID ${reviewerID} was not found. Check your governance group for orphan members`
                        ctx.handleError(error)
                    }
                }
            }

            //BUILD RESULTING ACCOUNTS
            logger.info('Building accounts.')

            const accounts = await ctx.getUniqueAccounts()

            logger.info('Sending accounts.')
            for (const account of accounts) {
                logger.info(account)
                res.send(account)
            }

            ctx.logErrors(context, input)
        } finally {
            clearInterval(interval)
        }
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
        const account = await ctx.buildUniqueAccountFromID(input.identity)
        logger.info(account)
        res.send(account)
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

        const account = ctx.buildUniqueAccountFromID(input.identity)
        account
            .then((result) => {
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
                result.attributes.uniqueID = uniqueID
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
