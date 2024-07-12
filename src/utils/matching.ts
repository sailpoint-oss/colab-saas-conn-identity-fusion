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
    const accountAttributes = buildAccountAttributesObject(account, mergingMap, true)
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
    getScore: (attribute?: string) => number,
    globalScore: boolean
): { identity: IdentityDocument; score: Map<string, string> }[] => {
    const similarMatches: { identity: IdentityDocument; score: Map<string, string> }[] = []
    const accountAttributes = buildAccountAttributesObject(account, mergingMap, true)
    const length = Object.keys(accountAttributes).length

    candidates: for (const candidate of candidates) {
        // const scores: number[] = []
        const scores = new Map<string, number>()
        attributes: for (const attribute of Object.keys(accountAttributes)) {
            let cValue, iValue
            iValue = accountAttributes[attribute] as string
            cValue = candidate.attributes![attribute] as string
            if (iValue && cValue) {
                const similarity = lig3(iValue, cValue)
                const score = similarity * 100
                if (!globalScore) {
                    const threshold = getScore(attribute)
                    if (score < threshold) {
                        continue candidates
                    }
                }
                scores.set(attribute, score)
            }
        }

        if (globalScore) {
            const finalScore =
                [...scores.values()].reduce((p, c) => {
                    return p + c
                }, 0) / length

            if (finalScore >= getScore()) {
                const score = new Map<string, string>()
                score.set('overall', finalScore.toFixed(0))
                similarMatches.push({ identity: candidate, score })
            }
        } else {
            const score = new Map<string, string>()
            scores.forEach((v, k) => score.set(k, v.toFixed(0)))
            similarMatches.push({ identity: candidate, score })
        }
    }

    return similarMatches
}
