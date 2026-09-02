import { daemonControlRpc } from '../daemon/controlSocket.js'
import { markDaemonHaltStanddown } from './daemonStanddown.js'
import { stopTask } from '../tasks/stopTask.js'
import { runningTaskIds, summarizeHalt, type HaltResult } from './haltDecide.js'

export { runningTaskIds, summarizeHalt, type HaltResult } from './haltDecide.js'

type LooseTask = { id: string; status: string }
type HaltContext = {
  getAppState: () => { tasks?: Record<string, LooseTask> }
  setAppState: (updater: (prev: unknown) => unknown) => void
}

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
  markDaemonHaltStanddown()
  let daemon: HaltResult['daemon']
  try {
    const reply = await daemonControlRpc({ op: 'shutdown', reapWorkers: true }, { timeoutMs: 3000 })
    daemon =
      reply.ok && reply.op === 'shutdown'
        ? { ok: true, reaped: reply.reaped, workers: reply.workers }
        : { ok: false, reason: 'no daemon running' }
  } catch {
    daemon = { ok: false, reason: 'no daemon running' }
  }
  return { tasksStopped, tasksFailed, daemon }
}
