// ============================================================================
//  switchboard/quitParksAll — CLOSE-ALL at the screen's quit (the control-
//  plane model, law 3): quitting the screen parks every session this
//  terminal was running — one park-all to the daemon from the shutdown
//  cleanup, bounded so an absent daemon never holds the exit. An idle
//  session parks at once; one mid-turn finishes its own turn, then parks;
//  a newborn is released; a chat another LIVE terminal is looking at is
//  theirs and stays. The owned daemon parks the estate again at its own
//  orphan reap (the backstop for a screen that died without its cleanup);
//  a persistent `mercury daemon` parks this terminal's sessions here.
// ============================================================================
import { registerCleanup } from '../../utils/cleanupRegistry.js'
import { logForDebugging } from '../../utils/debug.js'

/** The terminal's own seat — the focusedBy/attachedBy grammar the
 *  connector's focus verbs stamp, so the daemon knows which chats were
 *  this screen's. */
const SEAT_BY = `operator:${process.pid}`
/** The cleanup budget: well inside the graceful shutdown's own cleanup
 *  window; a daemon that does not answer parks the estate on its own. */
const PARK_ALL_BUDGET_MS = 1500

let armed = false

/** Arm the quit's park-all once per screen process (the interactive boot). */
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
