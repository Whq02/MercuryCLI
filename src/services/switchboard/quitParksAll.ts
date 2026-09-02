import { registerCleanup } from '../../utils/cleanupRegistry.js'
import { logForDebugging } from '../../utils/debug.js'

const SEAT_BY = `operator:${process.pid}`
const PARK_ALL_BUDGET_MS = 1500

let armed = false

export function armQuitParksAll(): void {
  if (armed) return
  armed = true
  registerCleanup(async () => {
    try {
      const { daemonControlRpc } = await import('../../daemon/controlSocket.js')
      const reply = (await daemonControlRpc(
        { op: 'sessionControl', action: 'park-all', sessionId: 'all', by: SEAT_BY } as never,
        { timeoutMs: PARK_ALL_BUDGET_MS },
      )) as { ok?: boolean; detail?: string; error?: string }
      logForDebugging(`[switchboard] the quit parks all: ${reply.ok === true ? (reply.detail ?? 'applied') : (reply.error ?? 'no daemon answered — its own orphan reap parks the estate')}`)
    } catch (e) {
      logForDebugging(`[switchboard] the quit parks all — the daemon was not reached (its own orphan reap parks the estate): ${e}`)
    }
  })
}
