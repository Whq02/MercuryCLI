// ============================================================================
//  haltAll — the operator's hard-stop / manual break (#35).
// ----------------------------------------------------------------------------
//  One gesture (the /halt command) tears down everything that could be running:
//   1. every IN-PROCESS running agent task (subagents/fleet) — via stopTask;
//   2. the scheduler DAEMON and every worker it hosts (any
//      rostered long-lived / fleet workers) — via the daemon `shutdown` control
//      RPC with reapWorkers:true (the same hardened teardown SIGINT/SIGTERM run).
//  The daemon is the lingering concern (in-process agents die with the foreground
//  anyway), but a hard stop kills both for a clean slate. Honest by construction:
//  it reports exactly what it stopped, and "no daemon running" is a success (there
//  was nothing to reap), not a failure.
// ============================================================================
import { daemonControlRpc } from '../daemon/controlSocket.js'
import { markDaemonHaltStanddown } from './daemonStanddown.js'
import { stopTask } from '../tasks/stopTask.js'
import { runningTaskIds, summarizeHalt, type HaltResult } from './haltDecide.js'

// Re-export the pure core so callers (and the /halt command) have one import.
export { runningTaskIds, summarizeHalt, type HaltResult } from './haltDecide.js'

type LooseTask = { id: string; status: string }
type HaltContext = {
  getAppState: () => { tasks?: Record<string, LooseTask> }
  setAppState: (updater: (prev: unknown) => unknown) => void
}

/** Execute the hard stop. Never throws — a missing daemon / a stubborn task is
 *  reported, not raised (a panic button must always complete). */
export async function haltAll(ctx: HaltContext): Promise<HaltResult> {
  const tasksStopped: string[] = []
  const tasksFailed: string[] = []
  for (const id of runningTaskIds(ctx.getAppState().tasks)) {
    try {
      await stopTask(id, ctx as Parameters<typeof stopTask>[1])
      tasksStopped.push(id)
    } catch {
      tasksFailed.push(id)
    }
  }
  // The operator said STOP: silent daemon auto-heals stand down from here
  // until an explicit engage gesture — the fix for the halt-then-respawn
  // loop ("an immediate second /halt reaped 4 MORE workers").
  markDaemonHaltStanddown()
  let daemon: HaltResult['daemon']
  try {
    const reply = await daemonControlRpc({ op: 'shutdown', reapWorkers: true }, { timeoutMs: 3000 })
    daemon =
      reply.ok && reply.op === 'shutdown'
        ? { ok: true, reaped: reply.reaped, workers: reply.workers }
        : { ok: false, reason: 'no daemon running' }
  } catch {
    // ENOCONN / timeout ⇒ no daemon was listening ⇒ nothing to reap (a success).
    daemon = { ok: false, reason: 'no daemon running' }
  }
  return { tasksStopped, tasksFailed, daemon }
}
