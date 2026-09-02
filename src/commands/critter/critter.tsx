import * as React from 'react'
import { CritterSelect } from '../../components/CritterSelect.js'
import type { LocalJSXCommandCall } from '../../types/command.js'

export const call: LocalJSXCommandCall = async onDone => {
  // Close with display:'skip' so the picker leaves NO transcript echo. A bare
  // onDone() hits the falsy-result branch in processSlashCommand and emits
  // `<local-command-stdout>(no content)</local-command-stdout>`; display:'skip'
  // short-circuits to messages:[] (no command-stdout, no "(no content)").
  return <CritterSelect onClose={(value?: unknown, options?: Parameters<typeof onDone>[1]) => { const v = typeof value === 'string' ? value : undefined; onDone(v, options ?? (v === undefined ? { display: 'skip' } : undefined)) }} />
}
