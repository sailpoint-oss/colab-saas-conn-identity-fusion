import { ActionSource } from '../model/action'

export const actions: ActionSource[] = [
    { id: 'reset', name: 'Reset unique ID', description: "Reset the account's unique ID " },
    { id: 'edit', name: 'Edit account', description: "Edit account's properties" },
    { id: 'report', name: 'Fusion report', description: 'Generate fusion report' },
]
