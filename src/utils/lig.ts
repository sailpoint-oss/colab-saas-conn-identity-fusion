//Adapted from https://yomguithereal.github.io/talisman/

import levenshtein from 'fast-levenshtein'

/**
 * LIG2 similarity metric.
 *
 * @param  {string} a - First sequence.
 * @param  {string} b - Second sequence.
 * @return {number}
 */
export function lig2(a: string, b: string): number {
    if (a === b) return 1

    // Swapping so that a is the shortest
    if (a.length > b.length) {
        const tmp = a
        a = b
        b = tmp
    }

    let C = levenshtein.get(a, b)
    let I = b.length - C

    return I / (I + C)
}

/**
 * LIG3 similarity metric.
 *
 * @param  {string} a - First sequence.
 * @param  {string} b - Second sequence.
 * @return {number}
 */
/**
 * Talisman metrics/lig
 * =====================
 *
 * LIG2 & LIG3 distances.
 *
 * Note that the LIG1 distance is not implemented here because it's deemed
 * less useful by the paper's authors and because they seem to use a different
 * definition of the Guth distance function that the widely accepted one (as
 * hinted in another paper).
 *
 * [Article]:
 * An Interface for Mining Genealogical Nominal Data Using the Concept of
 * linkage and a Hybrid Name Matching Algorithm.
 * Chakkrit Snae, Bernard Diaz
 * Department of Computer Science, The University of Liverpool
 * Peach Street, Liverpool, UK, L69 7ZF
 */
export function lig3(a: string, b: string): number {
    if (a === b) return 1

    // Swapping so that a is the shortest
    if (a.length > b.length) {
        const tmp = a
        a = b
        b = tmp
    }

    let C = levenshtein.get(a, b)
    let I = b.length - C

    return (2 * I) / (2 * I + C)
}
