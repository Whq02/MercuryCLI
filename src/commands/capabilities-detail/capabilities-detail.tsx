import * as React from 'react'
import { CapabilityManagerView } from '../../components/mercury-ui/parity/CapabilityManagerView.js'
import type { LocalJSXCommandCall } from '../../types/command.js'

export const call: LocalJSXCommandCall = async onDone => {
  return <CapabilityManagerView onClose={() => onDone(undefined, { display: 'skip' })} />
}
