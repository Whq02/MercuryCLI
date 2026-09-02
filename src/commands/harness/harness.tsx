import * as React from 'react'
import { HarnessView } from '../../components/mercury-ui/parity/HarnessView.js'
import type { LocalJSXCommandCall } from '../../types/command.js'

// The /harness drill-in mounts the Mercury HarnessView (design-system
// surface) — the /capabilities pattern.
export const call: LocalJSXCommandCall = async onDone => {
  return <HarnessView onClose={() => onDone(undefined, { display: 'skip' })} />
}
