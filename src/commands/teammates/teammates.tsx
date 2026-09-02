import * as React from 'react'
import { TeammateChatsView } from '../../components/mercury-ui/screens/TeammateChatsView.js'
import type { LocalJSXCommandCall } from '../../types/command.js'

// Each Mercury view is a self-contained <View onClose> (the /parity pattern).
export const call: LocalJSXCommandCall = async onDone => {
  return <TeammateChatsView onClose={(value?: unknown, options?: Parameters<typeof onDone>[1]) => { const v = typeof value === 'string' ? value : undefined; onDone(v, options ?? (v === undefined ? { display: 'skip' } : undefined)) }} />
}
