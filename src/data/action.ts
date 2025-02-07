import { ActionSource } from '../model/action'

export const actions: ActionSource[] = [
    { id: 'reset', name: 'Reset unique ID', description: "Reset the account's unique ID " },
    { id: 'edit', name: 'Edit account', description: "Edit account's properties" },
    { id: 'unedit', name: 'Unedit account', description: 'Undo manually set properties' },
    { id: 'report', name: 'Fusion report', description: 'Generate fusion report' },
    { id: 'fusion', name: 'Fusion account', description: 'Create a fusion account' },
]
