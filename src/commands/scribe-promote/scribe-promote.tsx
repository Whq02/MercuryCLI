import * as React from 'react'
import { ScribeCandidatesView } from '../../components/ScribeCandidatesView.js'
import type { LocalJSXCommandCall } from '../../types/command.js'

// Each Mercury view is a self-contained <View onClose> (the /cards · /parity pattern).
export const call: LocalJSXCommandCall = async onDone => {
  return <ScribeCandidatesView onClose={(value?: unknown, options?: Parameters<typeof onDone>[1]) => { const v = typeof value === 'string' ? value : undefined; onDone(v, options ?? (v === undefined ? { display: 'skip' } : undefined)) }} />
}
