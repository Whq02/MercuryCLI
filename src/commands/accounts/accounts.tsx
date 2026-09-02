import * as React from 'react'
import { AccountView } from '../../components/mercury-ui/parity/AccountView.js'
import type { LocalJSXCommandCall } from '../../types/command.js'

// Each Mercury view is a self-contained <View onClose> (the /parity pattern).
export const call: LocalJSXCommandCall = async onDone => {
  return <AccountView onClose={(value?: unknown, options?: Parameters<typeof onDone>[1]) => { const v = typeof value === 'string' ? value : undefined; onDone(v, options ?? (v === undefined ? { display: 'skip' } : undefined)) }} />
}
