import { Account, IdentityDocument } from 'sailpoint-api-client'
import { buildAccountAttributesObject, buildIdentityAttributesObject } from '.'
import { lig3 } from './lig'

//================ MATCHING ================
export const findIdenticalMatch = (
    account: Account,
    candidates: IdentityDocument[],
    mergingMap: {
        account: string[]
        identity: string
        uidOnly: boolean
    }[]
): IdentityDocument | undefined => {
    let match: IdentityDocument | undefined
    const accountAttributes = buildAccountAttributesObject(account, mergingMap)
    const accountStringAttributes = JSON.stringify(accountAttributes)
    const candidatesAttributes = candidates.map((x) => buildIdentityAttributesObject(x, mergingMap))
    const candidatesStringAttributes = candidatesAttributes.map((x) => JSON.stringify(x))

    const firstIndex = candidatesStringAttributes.indexOf(accountStringAttributes)
    if (firstIndex > -1) {
        match = candidates[firstIndex]
    }

    return match
}

export const findSimilarMatches = (
    account: Account,
    candidates: IdentityDocument[],
    mergingMap: {
        account: string[]
        identity: string
        uidOnly: boolean
    }[],
    score: number
): { identity: IdentityDocument; score: string }[] => {
    const similarMatches: { identity: IdentityDocument; score: string }[] = []
    const accountAttributes = buildAccountAttributesObject(account, mergingMap)
    const length = Object.keys(accountAttributes).length

    for (const candidate of candidates) {
        const scores: number[] = []
        for (const attribute of Object.keys(accountAttributes)) {
            let cValue, iValue
            iValue = accountAttributes[attribute] as string
            cValue = candidate.attributes![attribute] as string
            if (iValue && cValue) {
                const similarity = lig3(iValue, cValue)
                scores.push(similarity)
            }
        }

        const finalScore =
            (scores.reduce((p, c) => {
                return p + c
            }, 0) /
                length) *
            100

        if (finalScore >= score) {
            similarMatches.push({ identity: candidate, score: finalScore.toFixed(0) })
        }
    }

    return similarMatches
}
