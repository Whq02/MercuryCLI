import * as React from 'react'
import { SubstratePanel } from '../../components/SubstratePanel.js'
import type { LocalJSXCommandCall } from '../../types/command.js'

export const call: LocalJSXCommandCall = async onDone => {
  // Close with display:'skip' so the panel leaves no "(no content)" echo.
  return <SubstratePanel onClose={(value?: unknown, options?: Parameters<typeof onDone>[1]) => { const v = typeof value === 'string' ? value : undefined; onDone(v, options ?? (v === undefined ? { display: 'skip' } : undefined)) }} />
}
