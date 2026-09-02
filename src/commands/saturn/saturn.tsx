import * as React from 'react'
import { BootSaturnScreen } from '../../components/BootSaturnScreen.js'
import type { LocalJSXCommandCall } from '../../types/command.js'

// /saturn — the scheduler screen's in-chat mount (the same
// component the Boot face's row opens as a layer; here it composes at a
// bounded height inside the chat — the command stays the door, never a
// route hop).
export const call: LocalJSXCommandCall = async onDone => {
  return <BootSaturnScreen onClose={(value?: string) => onDone(value, value === undefined ? { display: 'skip' } : undefined)} />
}
