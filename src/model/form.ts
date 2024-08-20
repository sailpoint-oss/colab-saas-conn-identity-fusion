import {
    Account,
    CreateFormDefinitionRequestBeta,
    FormConditionBeta,
    FormDefinitionInputBeta,
    FormDefinitionInputBetaTypeEnum,
    FormElementBeta,
    FormOwnerBeta,
    IdentityDocument,
    SourceOwner,
} from 'sailpoint-api-client'
import { capitalizeFirstLetter } from '../utils'
import { UniqueAccount } from './account'

export const buildID = (entity: any, attribute: string): string => {
    let name
    if (typeof entity === 'string') {
        name = entity
    } else {
        name = entity.id
    }
    // name = name.replace(/\d/g, 'a')
    const id = `${name}.${attribute}`.toLowerCase()

    return id
}

type Option = { label: string; value: string; subLabel?: string | null }

const buildFormDefinitionInput = (name: string, description?: any): FormDefinitionInputBeta => {
    let desc = null
    if (description) {
        desc = description.toString()
    }
    const input: FormDefinitionInputBeta = {
        id: name,
        type: FormDefinitionInputBetaTypeEnum.String,
        label: name,
        description: desc,
    }

    return input
}

const buildFormDefinitionTextElement = (key: string, name: string): FormElementBeta => {
    const label = capitalizeFirstLetter(name) as any
    const element: FormElementBeta = {
        id: key,
        key,
        elementType: 'TEXT',
        config: {
            label,
        },
    }

    return element
}

const buildFormDefinitionSelectElement = (key: string, label: any, options: Option[]): FormElementBeta => {
    const element: FormElementBeta = {
        config: {
            dataSource: {
                config: {
                    options,
                },
                dataSourceType: 'STATIC',
            },
            forceSelect: true as any,
            label,
            maximum: 1 as any,
            required: true as any,
        },
        elementType: 'SELECT',
        id: key,
        key,
        validations: [
            {
                validationType: 'REQUIRED',
            },
        ],
    }

    return element
}

const buildTopSection = (label: string, description: string, attributes?: string[]): FormElementBeta => {
    let formElements: any[] = []
    if (attributes) {
        formElements = attributes.map((x) => buildFormDefinitionTextElement(x, x))
    }
    return {
        id: 'topSection',
        key: 'topSection',
        elementType: 'SECTION',
        config: {
            alignment: 'CENTER' as any,
            description: description as any,
            label: label as any,
            labelStyle: 'h2' as any,
            showLabel: true as any,
            formElements,
        },
    }
}

const buildSelectionSection = (
    identity: IdentityDocument,
    score?: Map<string, string>,
    attributes?: string[]
): FormElementBeta => {
    const id = buildID(identity, 'selectionSection')
    let formElements: any[] = []
    if (attributes) {
        formElements = attributes.map((x) => buildFormDefinitionTextElement(buildID(identity, x), x))
        if (score) {
            const scoreElement = buildScoreSection(identity.id, [...score.keys()])
            formElements.push(scoreElement)
        }
    }
    return {
        id,
        key: id,
        elementType: 'SECTION',
        config: {
            alignment: 'CENTER' as any,
            label: `${identity.displayName} details` as any,
            labelStyle: 'h4' as any,
            showLabel: true as any,
            formElements,
        },
    }
}

const buildIdentitiesSection = (options: Option[]): FormElementBeta => {
    return {
        id: 'identitiesSection',
        key: 'identitiesSection',
        elementType: 'SECTION',
        config: {
            alignment: 'CENTER' as any,
            label: 'Existing identities' as any,
            labelStyle: 'h3' as any,
            showLabel: true as any,
            formElements: [buildFormDefinitionSelectElement('identities', 'Identities', options)],
        },
    }
}

const buildScoreSection = (id: string, scoreAttributes: string[]): FormElementBeta => {
    const scoreElements = scoreAttributes.map((x) =>
        buildFormDefinitionTextElement(buildID(id, `${x}.score`), `${x} score`)
    )
    const thresholdElements = scoreAttributes.map((x) =>
        buildFormDefinitionTextElement(buildID(id, `${x}.threshold`), `${x} threshold`)
    )

    return {
        id: `${id}.scoreSection`,
        key: `${id}.scoreSection`,
        elementType: 'COLUMN_SET' as any,
        config: {
            columnCount: 2 as any,
            columns: [scoreElements, thresholdElements],
            alignment: 'CENTER' as any,
            label: 'Score' as any,
            labelStyle: 'h5' as any,
            showLabel: true as any,
        },
    }
}

const buildOptions = (identities: IdentityDocument[], label: string, value: string): Option[] => {
    const options: Option[] = identities.map((x) => ({
        label: x.attributes!.uid!,
        value: x.attributes!.uid!,
    }))
    options.push({ label, value })

    return options
}

const buildUniqueFormConditions = (
    attributes: string[],
    targets: { identity: IdentityDocument; score: Map<string, string> }[],
    value: string
): FormConditionBeta[] => {
    const formConditions: FormConditionBeta[] = [
        {
            ruleOperator: 'OR',
            rules: [
                {
                    sourceType: 'ELEMENT',
                    source: 'identities',
                    operator: 'EQ',
                    valueType: 'STRING',
                    value: value as any,
                },
                {
                    sourceType: 'ELEMENT',
                    source: 'identities',
                    operator: 'EM',
                    valueType: 'STRING',
                    value: null as any,
                },
            ],
            effects: targets.map(({ identity }) => ({
                effectType: 'HIDE',
                config: {
                    element: buildID(identity, 'selectionSection') as any,
                },
            })),
        },
        {
            ruleOperator: 'AND',
            rules: [
                {
                    sourceType: 'INPUT',
                    source: 'name',
                    operator: 'NOT_EM',
                    valueType: 'STRING',
                    value: null as any,
                },
            ],
            effects: attributes
                .map((x) =>
                    targets.map(({ identity }) => ({
                        effectType: 'DISABLE',
                        config: {
                            element: buildID(identity, x),
                        },
                    }))
                )
                .flat() as any[],
        },
    ]

    for (const attribute of attributes) {
        formConditions.push({
            ruleOperator: 'AND',
            rules: [
                {
                    sourceType: 'INPUT',
                    source: buildID(value, attribute),
                    operator: 'NOT_EM',
                    valueType: 'STRING',
                    value: null as any,
                },
            ],
            effects: [
                {
                    effectType: 'SET_DEFAULT_VALUE',
                    config: {
                        defaultValueLabel: buildID(value, attribute) as any,
                        element: attribute as any,
                    },
                },
                {
                    effectType: 'ENABLE',
                    config: {
                        element: attribute as any,
                    },
                },
            ],
        })
    }

    for (const target of targets) {
        const { identity, score } = target
        const attrs = attributes.filter((x) => x in identity.attributes!)
        for (const attr of attrs) {
            const id = buildID(identity, attr)
            formConditions.push({
                ruleOperator: 'AND',
                rules: [
                    {
                        sourceType: 'INPUT',
                        source: id,
                        operator: 'NOT_EM',
                        valueType: 'STRING',
                        value: null as any,
                    },
                ],
                effects: [
                    {
                        effectType: 'SET_DEFAULT_VALUE',
                        config: {
                            defaultValueLabel: id as any,
                            element: id as any,
                        },
                    },
                ],
            })
        }

        for (const attr of score.keys()) {
            for (const metric of ['score', 'threshold']) {
                const id = buildID(identity, `${attr}.${metric}`)
                formConditions.push({
                    ruleOperator: 'AND',
                    rules: [
                        {
                            sourceType: 'INPUT',
                            source: id,
                            operator: 'NOT_EM',
                            valueType: 'STRING',
                            value: null as any,
                        },
                    ],
                    effects: [
                        {
                            effectType: 'SET_DEFAULT_VALUE',
                            config: {
                                defaultValueLabel: id as any,
                                element: id as any,
                            },
                        },
                        {
                            effectType: 'DISABLE',
                            config: {
                                element: id as any,
                            },
                        },
                    ],
                })
            }
        }
    }

    for (const target of targets) {
        const { identity } = target
        formConditions.push({
            ruleOperator: 'AND',
            rules: [
                {
                    sourceType: 'ELEMENT',
                    source: 'identities',
                    operator: 'EQ',
                    valueType: 'STRING',
                    value: identity.attributes!.uid! as any,
                },
            ],
            effects: [
                {
                    effectType: 'SHOW',
                    config: {
                        element: buildID(identity, 'selectionSection') as any,
                    },
                },
            ],
        })
    }

    return formConditions
}

export class UniqueForm implements CreateFormDefinitionRequestBeta {
    public static NEW_IDENTITY = 'newidentity'
    name: string
    formInput: FormDefinitionInputBeta[] | undefined
    formElements: FormElementBeta[] | undefined
    formConditions: FormConditionBeta[] | undefined
    owner: FormOwnerBeta

    constructor(
        name: string,
        owner: SourceOwner,
        account: Account,
        targets: { identity: IdentityDocument; score: Map<string, string> }[],
        attributes: string[],
        getScore: (attribute?: string) => number
    ) {
        this.name = name
        this.owner = owner
        this.formInput = []

        // for (const attribute of attributes) {
        //     for (const { identity, score } of targets) {
        //         let name = buildID(identity, attribute)
        //         this.formInput.push(buildFormDefinitionInput(name, identity.attributes![attribute]))

        //         name = buildID(identity, `${attribute}.score`)
        //         this.formInput.push(buildFormDefinitionInput(name, score.get(attribute)))

        //         name = buildID(identity, `${attribute}.threshold`)
        //         this.formInput.push(buildFormDefinitionInput(name, getScore(attribute)))
        //     }
        //     const name = buildID(UniqueForm.NEW_IDENTITY, attribute)
        //     this.formInput.push(buildFormDefinitionInput(name, account.attributes![attribute]))
        // }

        for (const attribute of attributes) {
            for (const { identity } of targets) {
                const name = buildID(identity, attribute)
                this.formInput.push(buildFormDefinitionInput(name, identity.attributes![attribute]))
            }
            const name = buildID(UniqueForm.NEW_IDENTITY, attribute)
            this.formInput.push(buildFormDefinitionInput(name, account.attributes![attribute]))
        }

        for (const { identity, score } of targets) {
            for (const attribute of score.keys()) {
                let name = buildID(identity, `${attribute}.score`)
                this.formInput.push(buildFormDefinitionInput(name, score.get(attribute)))

                name = buildID(identity, `${attribute}.threshold`)
                this.formInput.push(buildFormDefinitionInput(name, getScore(attribute)))
            }
        }

        this.formInput.push(buildFormDefinitionInput('name', account.nativeIdentity))
        this.formInput.push(buildFormDefinitionInput('account', account.id))
        this.formInput.push(buildFormDefinitionInput('source', account.sourceName))
        const options = buildOptions(
            targets.map((x) => x.identity),
            'This is a new identity',
            'This is a new identity'
        )
        const label = `Potential Identity Merge from source ${account.sourceName}`
        const description =
            'Potentially duplicated identity was found. Please review the list of possible matches from existing identities and select the right one.'
        const topSection = buildTopSection(label, description, attributes)
        const identitiesSection = buildIdentitiesSection(options)
        this.formElements = [topSection, identitiesSection]
        for (const { identity, score } of targets) {
            const section = buildSelectionSection(identity, score, attributes)
            this.formElements.push(section)
        }
        this.formConditions = buildUniqueFormConditions(attributes, targets, UniqueForm.NEW_IDENTITY)
    }
}

const buildEditFormConditions = (attributes: string[], id: string): FormConditionBeta[] => {
    const formConditions: FormConditionBeta[] = []

    for (const attribute of attributes) {
        formConditions.push({
            ruleOperator: 'AND',
            rules: [
                {
                    sourceType: 'INPUT',
                    source: buildID(id, attribute),
                    operator: 'NOT_EM',
                    valueType: 'STRING',
                    value: null as any,
                },
            ],
            effects: [
                {
                    effectType: 'SET_DEFAULT_VALUE',
                    config: {
                        defaultValueLabel: buildID(id, attribute) as any,
                        element: attribute as any,
                    },
                },
                {
                    effectType: 'ENABLE',
                    config: {
                        element: attribute as any,
                    },
                },
            ],
        })
    }

    return formConditions
}

export class EditForm implements CreateFormDefinitionRequestBeta {
    name: string
    formInput: FormDefinitionInputBeta[] | undefined
    formElements: FormElementBeta[] | undefined
    formConditions: FormConditionBeta[] | undefined
    owner: FormOwnerBeta

    constructor(name: string, owner: SourceOwner, account: UniqueAccount, attributes: string[]) {
        this.name = name
        this.owner = owner
        this.formInput = []

        for (const attribute of attributes) {
            const name = buildID(account.identity!, attribute)
            this.formInput.push(buildFormDefinitionInput(name, account.attributes![attribute]))
        }

        this.formInput.push(buildFormDefinitionInput('name', account.uuid))
        this.formInput.push(buildFormDefinitionInput('account', account.identity))

        const label = `${account.uuid} account edit`
        const description =
            'These changes will be processed by the next account aggregation after submission. Changes will be persisted until a new source account is manually assigned or account is unedited.'
        const topSection = buildTopSection(label, description, attributes)
        this.formElements = [topSection]
        this.formConditions = buildEditFormConditions(attributes, account.identity!)
    }
}
