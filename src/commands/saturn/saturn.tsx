import * as React from 'react'
import { BootSaturnScreen } from '../../components/BootSaturnScreen.js'
import type { LocalJSXCommandCall } from '../../types/command.js'

export const call: LocalJSXCommandCall = async onDone => {
  return <BootSaturnScreen onClose={(value?: string) => onDone(value, value === undefined ? { display: 'skip' } : undefined)} />
}
