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
import { EditEmail, ReviewEmail } from './model/email'
import { buildReviewFromFormInstance, datedMessage, getFormValue, opLog, deleteArrayItem } from './utils'

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
        await ctx.init(undefined, true)
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
            await ctx.init(input.schema)
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
                logger.info('Processing existing unique forms.')
                const forms = await ctx.listUniqueForms()
                forms: for (const currentForm of forms) {
                    let cancelled = true
                    let finished = false
                    const accountID = getFormValue(currentForm, 'account')
                    const instances = ctx.listUniqueFormInstancesByForm(currentForm)
                    formInstances: for (const currentFormInstance of instances) {
                        logger.debug(`Processing form instance ${currentForm.name} (${currentFormInstance.id}).`)
                        const formName = currentForm.name
                        let uniqueAccount: Account | undefined

                        switch (currentFormInstance.state) {
                            case 'COMPLETED':
                                const { decision, account, message } =
                                    await ctx.processUniqueFormInstance(currentFormInstance)
                                logger.debug(`Result: ${message}.`)

                                const identityMatch = await ctx.getIdentityByUID(decision)

                                if (identityMatch) {
                                    logger.debug(`Updating existing account for ${decision}.`)
                                    uniqueAccount = (await ctx.getAccountByIdentity(identityMatch)) as Account
                                    const uncorrelatedAccount = (await ctx.getAccount(accountID)) as Account
                                    const msg = datedMessage(message, uncorrelatedAccount)
                                    const attributes = uniqueAccount.attributes!
                                    attributes.accounts.push(account)
                                    attributes.history.push(msg)
                                    attributes.statuses.push('manual')
                                    deleteArrayItem(attributes.statuses, 'edited')
                                } else {
                                    logger.debug(`Creating new unique account.`)
                                    const pendingAccount = pendingAccounts.find((x) => x.id === account) as Account

                                    try {
                                        uniqueAccount = await ctx.buildUniqueAccount(
                                            pendingAccount,
                                            'authorized',
                                            message
                                        )
                                    } catch (e) {
                                        ctx.handleError(e)
                                    }
                                }

                                finished = true
                                ctx.deleteUniqueFormInstance(currentFormInstance)
                                break formInstances

                            case 'CANCELLED':
                                logger.debug(`${currentForm.name} (${currentFormInstance.id}) was cancelled.`)
                                ctx.deleteUniqueFormInstance(currentFormInstance)
                                break

                            default:
                                cancelled = false
                                logger.debug(`No decision made yet for ${formName} instance.`)
                        }
                    }

                    pendingAccounts = pendingAccounts.filter((x) => x.id !== accountID)

                    if (finished || cancelled) {
                        try {
                            logger.info(`Deleting form ${currentForm.name}.`)
                            await ctx.deleteUniqueForm(currentForm)
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
                    }
                } catch (e) {
                    ctx.handleError(e)
                }
            }

            if (await ctx.isMergingEnabled()) {
                //PROCESS FORMS
                const forms = await ctx.listUniqueForms()
                logger.debug(`Checking unique form instances exist`)
                for (const form of forms) {
                    const sourceName = getFormValue(form, 'source')
                    const reviewerIDs = await ctx.listReviewerIDs(sourceName)

                    for (const reviewerID of reviewerIDs) {
                        if (ctx.isSourceReviewer(sourceName, reviewerID)) {
                            const reviewer = (await ctx.getIdentityById(reviewerID)) as IdentityDocument
                            let currentFormInstance = ctx.getUniqueFormInstanceByReviewerID(form, reviewerID)

                            if (!currentFormInstance) {
                                currentFormInstance = await ctx.createUniqueFormInstance(form, reviewerID)
                                logger.info(
                                    `Form URL for ${reviewer.attributes!.uid}: ${currentFormInstance.standAloneFormUrl}`
                                )
                                // Send notifications
                                logger.info(`Sending email notifications for ${form.name}`)
                                const email = new ReviewEmail(reviewer, form.name!, currentFormInstance)
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
                        const reviewer = (await ctx.getIdentityById(reviewerID)) as IdentityDocument
                        const reviewerAccount = ctx.getIdentityAccount(reviewer)!
                        reviewerAccount.attributes!.reviews = []
                        for (const instance of ctx.listUniqueFormInstancesByReviewerID(reviewerID)) {
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

            //PROCESS EDIT FORM INSTANCES
            const forms = await ctx.listEditForms()
            logger.info('Processing existing edit forms.')
            forms: for (const currentForm of forms) {
                let cancelled = true
                let finished = false
                const accountID = getFormValue(currentForm, 'account.id')
                const account = (await ctx.getFusionAccount(accountID)) as Account
                const instances = ctx.listEditFormInstancesByForm(currentForm)
                formInstances: for (const currentFormInstance of instances) {
                    logger.debug(`Processing form instance ${currentForm.name} (${currentFormInstance.id}).`)
                    const formName = currentForm.name

                    switch (currentFormInstance.state) {
                        case 'COMPLETED':
                            //TODO
                            ctx.processEditFormInstanceEdits(currentFormInstance, account)
                            const reviewer = await ctx.getIdentityById(currentFormInstance.recipients![0].id!)
                            account.attributes!.statuses.push('edited')
                            const message = datedMessage(`Edited by ${reviewer?.displayName}`)
                            account.attributes!.history.push(message)

                            finished = true
                            break formInstances

                        case 'CANCELLED':
                            logger.debug(`${currentForm.name} (${currentFormInstance.id}) was cancelled.`)
                            break

                        default:
                            cancelled = false
                            logger.debug(`No changes made yet for ${formName} instance.`)
                    }
                }

                if (finished || cancelled) {
                    try {
                        logger.info(`Deleting form ${currentForm.name}.`)
                        await ctx.deleteEditForm(currentForm)
                    } catch (e) {
                        const error = `Error deleting form with ID ${currentForm.name}`
                        ctx.handleError(error)
                    }
                }
            }

            //BUILD RESULTING ACCOUNTS
            logger.info('Sending accounts.')
            for await (const account of ctx.listUniqueAccounts()) {
                // console.log(`${new Date().toISOString()} ${account.attributes.uniqueID}`)
                logger.debug({ account })
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

        await ctx.init(input.schema, true)
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
        const entitlementSelectionError = `Only action source reviewer and report entitlements can be requested on account creation`
        opLog(config, input)

        if (input.attributes.statuses) {
            throw new ConnectorError(entitlementSelectionError, ConnectorErrorType.Generic)
        }

        const actions = [].concat(input.attributes.actions)
        let uniqueAccount: Account | undefined
        let originAccount: Account | undefined

        for (const action of actions) {
            switch (action) {
                case 'reset':
                    throw new ConnectorError(entitlementSelectionError, ConnectorErrorType.Generic)

                case 'edit':
                    throw new ConnectorError(entitlementSelectionError, ConnectorErrorType.Generic)

                case 'unedit':
                    throw new ConnectorError(entitlementSelectionError, ConnectorErrorType.Generic)

                case 'report':
                    throw new ConnectorError(entitlementSelectionError, ConnectorErrorType.Generic)

                default:
                    if (!uniqueAccount) {
                        logger.info(`Creating ${input.attributes.uniqueID} account.`)

                        await ctx.init(input.schema)

                        const identity = (await ctx.getIdentityByUID(input.attributes.uniqueID)) as IdentityDocument
                        originAccount = (await ctx.getAccountByIdentity(identity)) as Account
                        originAccount.attributes = { ...originAccount.attributes, ...identity.attributes }
                        const message = 'Created from access request'
                        uniqueAccount = await ctx.buildUniqueAccount(originAccount, 'reviewer', message)

                        ctx.setUUID(uniqueAccount)
                    }
                    const sourceName = ctx.getSourceNameByID(action)
                    const message = datedMessage(`Reviewer assigned for ${sourceName} source`, originAccount)
                    uniqueAccount.attributes!.actions.push(action)
                    uniqueAccount.attributes!.statuses.push('reviewer')
                    uniqueAccount.attributes!.history.push(message)

                    break
            }
        }

        const account = (await ctx.refreshUniqueAccount(uniqueAccount!)) as UniqueAccount

        logger.info({ account })
        res.send(account)
    }

    const stdAccountUpdate: StdAccountUpdateHandler = async (context, input, res) => {
        opLog(config, input)

        logger.info(`Updating ${input.identity} account.`)

        if (config.reset) return

        await ctx.init(input.schema, true)

        let account = await ctx.buildUniqueAccountFromID(input.identity)
        let message: string

        if (input.changes) {
            for (const change of input.changes) {
                switch (change.attribute) {
                    case 'actions':
                        switch (change.value) {
                            case 'reset':
                                await ctx.resetUniqueID(account)
                                message = datedMessage('UniqueID reset')
                                const history = account.attributes!.history as string[]
                                history.push(message)
                                break

                            case 'edit':
                                const form = await ctx.createEditForm(account)
                                const reviewerIDs = await ctx.listReviewerIDs()

                                for (const reviewerID of reviewerIDs) {
                                    const reviewer = (await ctx.getIdentityById(reviewerID)) as IdentityDocument
                                    let currentFormInstance = await ctx.getEditFormInstanceByReviewerID(
                                        form,
                                        reviewerID
                                    )

                                    if (!currentFormInstance) {
                                        currentFormInstance = await ctx.createEditFormInstance(form, reviewerID)
                                        logger.info(
                                            `Form URL for ${reviewer.attributes!.uid}: ${currentFormInstance.standAloneFormUrl}`
                                        )
                                        // Send notifications
                                        logger.info(`Sending email notifications for ${form.name}`)
                                        const email = new EditEmail(reviewer, form.name!, currentFormInstance)
                                        await ctx.sendEmail(email)
                                    }
                                }
                                break

                            case 'unedit':
                                const fusionAccount = (await ctx.getFusionAccount(input.identity)) as Account
                                fusionAccount.modified = new Date(0).toISOString()
                                deleteArrayItem(fusionAccount.attributes!.statuses as string[], 'edit')
                                account = (await ctx.refreshUniqueAccount(fusionAccount)) as UniqueAccount
                                break

                            case 'report':
                                await ctx.init()
                                ctx.buildReport(input.identity)
                                break

                            default:
                                const sourceIDs = ctx.listSources().map((x) => x.id!)
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
                                        deleteArrayItem(actions, change.value)
                                        if (!sourceIDs.some((x) => actions.includes(x))) {
                                            deleteArrayItem(statuses, 'reviewer')
                                        }
                                        break
                                    case AttributeChangeOp.Set:
                                        if (!statuses.includes('edited')) {
                                            const now = new Date().toISOString().split('T')[0]
                                            message = `[${now}] Account edited by attribute sync`
                                            statuses.push('edited')
                                            account.attributes[change.attribute] = change.value
                                            const history = account.attributes!.history as string[]
                                            history.push(message)
                                        }
                                        break

                                    default:
                                        break
                                }
                                break
                        }
                        break
                    case 'statuses':
                        message = 'Status entitlements are not designed for assigment. Use action entitlements instead.'
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

        logger.info({ account })
        res.send(account)
    }

    const stdAccountEnable: StdAccountEnableHandler = async (context, input, res) => {
        opLog(config, input)

        logger.info(`Enabling ${input.identity} account.`)

        if (config.reset) return

        await ctx.init(input.schema, true)

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

        await ctx.init(input.schema, true)

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
            await ctx.init(undefined, true)
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

        await ctx.init(undefined, true)
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
