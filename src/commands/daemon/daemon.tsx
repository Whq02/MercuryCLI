import * as React from 'react'
import { DaemonSupervisorView } from '../../components/mercury-ui/parity/DaemonSupervisorView.js'
import type { LocalJSXCommandCall } from '../../types/command.js'

// Each Mercury view is a self-contained <View onClose> (the /parity pattern).
// display:'skip' — a surface-mounting command leaves NO transcript ack; the
// bare onDone form rendered a "(no content)" stdout row (operator
// screenshot).
export const call: LocalJSXCommandCall = async (onDone, _context, args) => {
  // `/daemon restart` — the version handshake's heal by hand: a daemon that
  // speaks the handshake re-executes itself as the deployed build (now when
  // idle, armed for its next idle moment otherwise); a pre-handshake daemon
  // is stopped when idle and this screen's own successor started (the
  // receipt names that posture). One typed receipt row, no cockpit.
  if (args.trim().split(/\s+/)[0] === 'restart') {
    const { restartDaemon } = await import('../../daemon/handshake.js')
    const { getCwd } = await import('../../utils/cwd.js')
    const receipt = await restartDaemon({ by: 'operator', posture: 'owned', dir: getCwd() })
    onDone(receipt.line, { display: 'system' })
    return null
  }
  return <DaemonSupervisorView onClose={(value?: unknown, options?: Parameters<typeof onDone>[1]) => { const v = typeof value === 'string' ? value : undefined; onDone(v, options ?? (v === undefined ? { display: 'skip' } : undefined)) }} />
}
