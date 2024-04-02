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

const buildID = (entity: any, attribute: string): string => {
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

const buildFormDefinitionTextElement = (key: string, label: any): FormElementBeta => {
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

const buildSelectionSection = (identity: IdentityDocument, attributes?: string[]): FormElementBeta => {
    const id = buildID(identity, 'selectionSection')
    let formElements: any[] = []
    if (attributes) {
        formElements = attributes.map((x) => buildFormDefinitionTextElement(buildID(identity, x), x))
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

const buildOptions = (targets: IdentityDocument[], label: string, value: string): Option[] => {
    const options: Option[] = targets.map((x) => ({
        label: x.attributes!.uid!,
        value: x.attributes!.uid!,
    }))
    options.push({ label, value })

    return options
}

const buildUniqueFormConditions = (
    attributes: string[],
    targets: IdentityDocument[],
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
            effects: targets.map((x) => ({
                effectType: 'HIDE',
                config: {
                    element: buildID(x, 'selectionSection') as any,
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
                    targets.map((y) => ({
                        effectType: 'DISABLE',
                        config: {
                            element: buildID(y, x),
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
                    effectType: 'DISABLE',
                    config: {
                        element: attribute as any,
                    },
                },
            ],
        })
    }

    for (const target of targets) {
        const attrs = attributes.filter((x) => x in target.attributes!)
        for (const attr of attrs) {
            const id = buildID(target, attr)
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
    }

    for (const target of targets) {
        formConditions.push({
            ruleOperator: 'AND',
            rules: [
                {
                    sourceType: 'ELEMENT',
                    source: 'identities',
                    operator: 'EQ',
                    valueType: 'STRING',
                    value: target.attributes!.uid! as any,
                },
            ],
            effects: [
                {
                    effectType: 'SHOW',
                    config: {
                        element: buildID(target, 'selectionSection') as any,
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
        targets: { identity: IdentityDocument; score: string }[],
        attributes: string[]
    ) {
        this.name = name
        this.owner = owner
        this.formInput = []
        const formAttributes = [...attributes, 'score']
        const identities: IdentityDocument[] = []

        for (const target of targets) {
            const identity = { ...target.identity }
            identity.attributes!.score = target.score
            identities.push(identity)
        }

        for (const attribute of formAttributes) {
            for (const identity of identities) {
                const name = buildID(identity, attribute)
                this.formInput.push(buildFormDefinitionInput(name, identity.attributes![attribute]))
            }
            const name = buildID(UniqueForm.NEW_IDENTITY, attribute)
            this.formInput.push(buildFormDefinitionInput(name, account.attributes[attribute]))
        }

        this.formInput.push(buildFormDefinitionInput('name', account.nativeIdentity))
        this.formInput.push(buildFormDefinitionInput('account', account.id))
        this.formInput.push(buildFormDefinitionInput('source', account.sourceName))
        const options = buildOptions(identities, 'This is a new identity', 'This is a new identity')
        const label = `Potential Identity Merge from source ${account.sourceName}`
        const description =
            'Potentially duplicated identity was found. Please review the list of possible matches from existing identities and select the right one.'
        const topSection = buildTopSection(label, description, attributes)
        const identitiesSection = buildIdentitiesSection(options)
        this.formElements = [topSection, identitiesSection]
        for (const identity of identities) {
            const section = buildSelectionSection(identity, formAttributes)
            this.formElements.push(section)
        }
        this.formConditions = buildUniqueFormConditions(formAttributes, identities, UniqueForm.NEW_IDENTITY)
    }
}
