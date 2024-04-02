export type Status = {
    name: string
    description: string
}

export const statuses: Status[] = [
    { name: 'authorized', description: 'An authoritative account was manually correlated by a reviewer' },
    { name: 'auto', description: 'An identical match was found for authoritative account' },
    { name: 'baseline', description: 'Baseline account' },
    { name: 'manual', description: 'A new base account was manually approved by a reviewer' },
    { name: 'orphan', description: 'No authoritative accounts left' },
    { name: 'reviewer', description: 'Base account for reviewer identity' },
    { name: 'unmatched', description: 'No match found for base account' },
]
