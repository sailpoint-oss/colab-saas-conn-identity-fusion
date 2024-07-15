import { StatusSource } from '../model/status'

export const statuses: StatusSource[] = [
    {
        id: 'authorized',
        name: 'authorized',
        description: 'An authoritative account was manually correlated by a reviewer',
    },
    { id: 'auto', name: 'Auto', description: 'An identical match was found for authoritative account' },
    { id: 'baseline', name: 'Baseline', description: 'Baseline account' },
    { id: 'manual', name: 'Manual', description: 'A new base account was manually approved by a reviewer' },
    { id: 'orphan', name: 'Orphan', description: 'No authoritative accounts left' },
    { id: 'unmatched', name: 'Unmatched', description: 'No match found for base account' },
    { id: 'reviewer', name: 'Reviewer', description: 'An identity deduplication reviewer of any source' },
]
