import {
    AttributeChangeOp,
    ConnectorError,
    ConnectorErrorType,
    StdAccountCreateHandler,
    StdAccountDisableHandler,
    StdAccountDiscoverSchemaHandler,
    StdAccountEnableHandler,
    StdAccountListHandler,
    StdAccountReadHandler,
    StdAccountUpdateHandler,
    StdEntitlementListHandler,
    StdEntitlementListOutput,
    StdTestConnectionHandler,
    createConnector,
    logger,
    readConfig,
} from '@sailpoint/connector-sdk'
import { Account, IdentityDocument } from 'sailpoint-api-client'
import { Email } from './model/email'
import { buildReviewFromFormInstance, datedMessage, getFormValue, opLog, replaceArrayItem } from './utils'

import { ContextHelper } from './contextHelper'
import { PROCESSINGWAIT } from './constants'
import { UniqueAccount } from './model/account'

// Connector must be exported as module property named connector
export const connector = async () => {
    const config = await readConfig()
    const ctx = new ContextHelper(config)

    //==============================================================================================================

    //TODO improve
    const stdTest: StdTestConnectionHandler = async (context, input, res) => {
        opLog(config, input)
        await ctx.init(true)
        const source = ctx.getSource()
        const sources = ctx.listSources()

        if (!source) {
            throw new ConnectorError('Unable to connect to IdentityNow! Please check your configuration')
        }

        if (sources.length < config.sources.length) {
            throw new ConnectorError('Unable to find all sources. Please check your configuration')
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
            opLog(config, input)

            //Resetting accounts
            if (config.reset) return

            //Compiling info
            logger.info('Loading data.')
            if (input.schema) {
                ctx.loadSchema(input.schema)
            }
            await ctx.init()
            const processedAccountIDs = ctx.listProcessedAccountIDs()
            let pendingAccounts: Account[]
            const authoritativeAccounts = await ctx.listAuthoritativeAccounts()
            pendingAccounts = authoritativeAccounts.filter((x) => !processedAccountIDs.includes(x.id!))
            if (config.includeExisting) {
                logger.debug('Including existing identities.')
            } else {
                logger.debug('Excluding existing identities.')
                pendingAccounts = pendingAccounts.filter((x) => x.uncorrelated === true)
            }

            if ((await ctx.isMergingEnabled()) && !ctx.isFirstRun()) {
                //PROCESS FORM INSTANCES
                logger.info('Processing existing forms.')
                const forms = await ctx.listForms()
                forms: for (const currentForm of forms) {
                    let cancelled = true
                    let finished = false
                    const accountID = getFormValue(currentForm, 'account')
                    const instances = ctx.listFormInstancesByForm(currentForm)
                    formInstances: for (const currentFormInstance of instances) {
                        logger.debug(`Processing form instance ${currentForm.name} (${currentFormInstance.id}).`)
                        const formName = currentForm.name

                        switch (currentFormInstance.state) {
                            case 'COMPLETED':
                                const { decision, account, message } =
                                    await ctx.processFormInstance(currentFormInstance)
                                logger.debug(`Result: ${message}.`)

                                const identityMatch = await ctx.getIdentityByUID(decision)

                                if (identityMatch) {
                                    logger.debug(`Updating existing account for ${decision}.`)
                                    const uniqueAccount = (await ctx.getAccountByIdentity(identityMatch)) as Account
                                    const uncorrelatedAccount = (await ctx.getAccount(accountID)) as Account
                                    const msg = datedMessage(message, uncorrelatedAccount)
                                    const attributes = uniqueAccount.attributes!
                                    attributes.accounts.push(account)
                                    attributes.history.push(msg)
                                    attributes.statuses.push('manual')
                                    replaceArrayItem(attributes.statuses, 'edited')
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
                        replaceArrayItem(pendingAccounts, index)
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
            logger.info('Processing existing identities.')
            const currentIdentityIDs = ctx.listCurrentIdentityIDs()
            //Process correlated accounts not processed yet
            const correlatedAccounts = pendingAccounts.filter(
                (x) => x.uncorrelated === false && !currentIdentityIDs.includes(x.identityId!)
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

            //CREATE BASELINE
            if (ctx.isFirstRun()) {
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
                    const uniqueForm = await ctx.processUncorrelatedAccount(uncorrelatedAccount)
                    if (uniqueForm) {
                        logger.debug(`Creating merging form`)
                        const form = await ctx.createUniqueForm(uniqueForm)
                        ctx.addForm(form)
                    }
                } catch (e) {
                    ctx.handleError(e)
                }
            }

            if (await ctx.isMergingEnabled()) {
                //PROCESS FORMS
                const forms = await ctx.listForms()
                logger.debug(`Checking form instances exist`)
                for (const form of forms) {
                    const sourceName = getFormValue(form, 'source')
                    const reviewerIDs = ctx.listReviewerIDs(sourceName)

                    for (const reviewerID of reviewerIDs) {
                        if (ctx.isSourceReviewer(sourceName, reviewerID)) {
                            const reviewer = ctx.getIdentityById(reviewerID)!
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
                        }
                    }
                }

                //PROCESS REVIEWERS
                logger.info('Processing reviewers.')
                const reviewerIDs = ctx.listAllReviewerIDs()

                for (const reviewerID of reviewerIDs) {
                    try {
                        const reviewer = ctx.getIdentityById(reviewerID)!
                        const reviewerAccount = ctx.getIdentityAccount(reviewer)!
                        reviewerAccount.attributes!.reviews = []
                        for (const instance of ctx.listFormInstancesByReviewerID(reviewerID)) {
                            const form = ctx.getFormByID(instance.formDefinitionId!)
                            if (form) {
                                const review = buildReviewFromFormInstance(instance)
                                reviewerAccount.attributes!.reviews.push(review)
                            }
                        }
                    } catch (error) {
                        ctx.handleError(error)
                    }
                }
            }

            //BUILD RESULTING ACCOUNTS
            logger.info('Sending accounts.')
            for await (const account of ctx.listUniqueAccounts()) {
                logger.info({ account })
                res.send(account)
            }

            ctx.logErrors(context, input)
        } finally {
            clearInterval(interval)
        }
    }

    const stdAccountRead: StdAccountReadHandler = async (context, input, res) => {
        opLog(config, input)

        logger.info(`Reading ${input.identity} account.`)

        if (config.reset) return

        await ctx.init(true)
        if (input.schema) {
            ctx.loadSchema(input.schema)
        }
        //Keepalive
        const interval = setInterval(() => {
            res.keepAlive()
        }, PROCESSINGWAIT)

        try {
            const account = await ctx.buildUniqueAccountFromID(input.identity)
            logger.info({ account })
            res.send(account)
        } catch (error) {
            logger.error(error)
        } finally {
            clearInterval(interval)
        }
    }

    const stdAccountCreate: StdAccountCreateHandler = async (context, input, res) => {
        opLog(config, input)

        logger.info(`Creating ${input.attributes.uniqueID} account.`)

        if (config.reset) return

        await ctx.init()
        if (input.schema) {
            ctx.loadSchema(input.schema)
        }
        //Keepalive
        const interval = setInterval(() => {
            res.keepAlive()
        }, PROCESSINGWAIT)

        try {
            if (input.attributes.actions && input.attributes.actions.length > 0) {
                const sourceIDs = ctx.listSources().map((x) => x.id)
                const actions = [].concat(input.attributes.actions)
                //Check that all requests are reviewer requests
                if (!actions.some((x) => !sourceIDs.includes(x))) {
                    const identity = (await ctx.getIdentityByUID(input.attributes.uniqueID)) as IdentityDocument
                    const originAccount = (await ctx.getAccountByIdentity(identity)) as Account
                    const uniqueAccount = await ctx.buildUniqueAccount(originAccount, 'reviewer', '')
                    uniqueAccount.attributes!.actions = []
                    for (const action of actions) {
                        const sourceName = ctx.getSourceNameByID(action)
                        const message = datedMessage(`Reviewer assigned for ${sourceName} source`, originAccount)
                        uniqueAccount.attributes!.actions.push(action)
                        uniqueAccount.attributes!.history.push(message)
                    }
                    ctx.setUUID(uniqueAccount)

                    const account = (await ctx.refreshUniqueAccount(uniqueAccount)) as UniqueAccount

                    logger.info({ account })
                    res.send(account)
                }
            } else {
                const message = `Only reviewer entitlements can be requested on account creation`
                throw new ConnectorError(message, ConnectorErrorType.Generic)
            }
        } catch (error) {
            logger.error(error)
        } finally {
            clearInterval(interval)
        }
    }

    const stdAccountUpdate: StdAccountUpdateHandler = async (context, input, res) => {
        opLog(config, input)

        logger.info(`Updating ${input.identity} account.`)

        if (config.reset) return

        await ctx.init(true)
        if (input.schema) {
            ctx.loadSchema(input.schema)
        }
        let account = await ctx.buildUniqueAccountFromID(input.identity)
        let message: string
        try {
            if (input.changes) {
                for (const change of input.changes) {
                    switch (change.attribute) {
                        case 'actions':
                            switch (change.value) {
                                case 'reset':
                                    account = await ctx.resetUniqueID(account)
                                    break

                                case 'edit':
                                    break

                                case 'report':
                                    break

                                default:
                                    const sourceIDs = ctx.listSources().map((x) => x.id)
                                    const statuses = account.attributes.statuses as string[]
                                    const actions = account.attributes.actions as string[]
                                    switch (change.op) {
                                        case AttributeChangeOp.Add:
                                            if (!statuses.includes('reviewer')) {
                                                statuses.push('reviewer')
                                            }
                                            if (sourceIDs.includes(change.value)) {
                                                actions.push(change.value)
                                            } else {
                                                message = `Source ID ${change.value} is not a currently configured source.`
                                                throw new ConnectorError(message, ConnectorErrorType.Generic)
                                            }
                                            break
                                        case AttributeChangeOp.Remove:
                                            replaceArrayItem(statuses, 'reviewer')
                                            replaceArrayItem(actions, change.value)
                                            break
                                        case AttributeChangeOp.Set:
                                            const now = new Date().toISOString().split('T')[0]
                                            message = `[${now}] Account edited by attribute sync`
                                            statuses.push('edited')
                                            account.attributes[change.attribute] = change.value
                                            const history = account.attributes!.history as string[]
                                            history.push(message)
                                            break

                                        default:
                                            break
                                    }
                                    break
                            }
                            break
                        case 'statuses':
                            message =
                                'Status entitlements are not designed for assigment. Use action entitlements instead.'
                            throw new ConnectorError(message, ConnectorErrorType.Generic)
                        default:
                            message = 'Operation not supported.'
                            throw new ConnectorError(message, ConnectorErrorType.Generic)
                    }
                }
                //Need to investigate about std:account:update operations without changes but adding this for the moment
            } else if ('attributes' in input) {
                logger.warn(
                    'No changes detected in account update. Please report unless you used attribute sync which is not supported.'
                )
            }
        } catch (e) {
            ctx.handleError(e)
        }

        logger.info({ account })
        res.send(account)
    }

    const stdAccountEnable: StdAccountEnableHandler = async (context, input, res) => {
        opLog(config, input)

        logger.info(`Enabling ${input.identity} account.`)

        if (config.reset) return

        await ctx.init(true)
        if (input.schema) {
            ctx.loadSchema(input.schema)
        }

        //Keepalive
        const interval = setInterval(() => {
            res.keepAlive()
        }, PROCESSINGWAIT)

        try {
            const account = await ctx.buildUniqueAccountFromID(input.identity)

            account.disabled = false
            account.attributes.IIQDisabled = false

            logger.info({ account })
            res.send(account)
        } catch (error) {
            logger.error(error)
        } finally {
            clearInterval(interval)
        }
    }

    const stdAccountDisable: StdAccountDisableHandler = async (context, input, res) => {
        opLog(config, input)

        logger.info(`Disabling ${input.identity} account.`)

        if (config.reset) return

        await ctx.init(true)
        if (input.schema) {
            ctx.loadSchema(input.schema)
        }

        //Keepalive
        const interval = setInterval(() => {
            res.keepAlive()
        }, PROCESSINGWAIT)

        try {
            const account = await ctx.buildUniqueAccountFromID(input.identity)

            account.disabled = true
            account.attributes.IIQDisabled = true

            logger.info({ account })
            res.send(account)
        } catch (error) {
            logger.error(error)
        } finally {
            clearInterval(interval)
        }
    }

    const stdEntitlementList: StdEntitlementListHandler = async (context, input, res) => {
        const c = 'stdEntitlementList'
        const errors: string[] = []
        opLog(config, input)

        try {
            // await ctx.checkAccountCreateProvisioningPolicy()

            let entitlements: StdEntitlementListOutput[]
            await ctx.init(true)
            const sources = ctx.listSources()
            switch (input.type) {
                case 'status':
                    entitlements = ctx.buildStatusEntitlements()
                    break

                case 'action':
                    entitlements = ctx.buildActionEntitlements()
                    break

                default:
                    const message = `Unsupported entitlement type ${input.type}`
                    throw new ConnectorError(message)
            }
            for (const e of entitlements) {
                logger.info({ e })
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
        opLog(config, input)
        logger.info('Building dynamic schema.')

        await ctx.init(true)
        const schema = await ctx.getSchema()

        logger.info({ schema })
        res.send(schema)
    }

    return createConnector()
        .stdTestConnection(stdTest)
        .stdAccountList(stdAccountList)
        .stdAccountRead(stdAccountRead)
        .stdAccountCreate(stdAccountCreate)
        .stdAccountUpdate(stdAccountUpdate)
        .stdAccountEnable(stdAccountEnable)
        .stdAccountDisable(stdAccountDisable)
        .stdEntitlementList(stdEntitlementList)
        .stdAccountDiscoverSchema(stdAccountDiscoverSchema)
}
