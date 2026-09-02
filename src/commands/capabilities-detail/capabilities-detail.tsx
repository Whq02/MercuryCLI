import * as React from 'react'
import { CapabilityManagerView } from '../../components/mercury-ui/parity/CapabilityManagerView.js'
import type { LocalJSXCommandCall } from '../../types/command.js'

// /capabilities-detail — an ALIAS of /capabilities: both mount the local-first
// capability center (readiness records + the flag-registry environment
// section). The running process owns every relevant local fact; remote
// enrichment, if it arrives, rides the same center as an extra source.
export const call: LocalJSXCommandCall = async onDone => {
  return <CapabilityManagerView onClose={() => onDone(undefined, { display: 'skip' })} />
}
