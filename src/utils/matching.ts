import { Account, IdentityDocument } from 'sailpoint-api-client'
import { buildAccountAttributesObject, buildIdentityAttributesObject } from '.'
import { lig3 } from './lig'
import { IdentityMatch, MergingMap } from '../model/types'

//================ MATCHING ================
export const findIdenticalMatch = (
    account: Account,
    candidates: IdentityDocument[],
    mergingMap: MergingMap[]
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
    mergingMap: MergingMap[],
    thresholdScore: number
): IdentityMatch[] => {
    const similarMatches: IdentityMatch[] = []
    const accountAttributes = buildAccountAttributesObject(account, mergingMap)
    const length = Object.keys(accountAttributes).length

    for (const candidate of candidates) {
        const scores: number[] = []
        for (const attribute of Object.keys(accountAttributes)) {
            let identityValue, accountValue
            accountValue = accountAttributes[attribute] as string
            identityValue = candidate.attributes![attribute] as string
            if (accountValue && identityValue) {
                // Score between 0 and 1
                const similarity = lig3(accountValue, identityValue)
                scores.push(similarity)
            }
        }

        // Average score between 0 and 100
        const finalScore =
            (scores.reduce((p, c) => {
                return p + c
            }, 0) /
                length) *
            100

        if (finalScore >= thresholdScore) {
            similarMatches.push({ identity: candidate, score: finalScore.toFixed(0) })
        }
    }

    return similarMatches
}
