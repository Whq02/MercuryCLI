import * as React from 'react'
import { DaemonSupervisorView } from '../../components/mercury-ui/parity/DaemonSupervisorView.js'
import type { LocalJSXCommandCall } from '../../types/command.js'

export const call: LocalJSXCommandCall = async (onDone, _context, args) => {
  if (args.trim().split(/\s+/)[0] === 'restart') {
    const { restartDaemon } = await import('../../daemon/handshake.js')
    const { getCwd } = await import('../../utils/cwd.js')
    const receipt = await restartDaemon({ by: 'operator', posture: 'owned', dir: getCwd() })
    onDone(receipt.line, { display: 'system' })
    return null
  }
  return <DaemonSupervisorView onClose={(value?: unknown, options?: Parameters<typeof onDone>[1]) => { const v = typeof value === 'string' ? value : undefined; onDone(v, options ?? (v === undefined ? { display: 'skip' } : undefined)) }} />
}
