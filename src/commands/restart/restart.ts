import type { WorkRowV1 } from '../../services/engine-connector/types.js'
import type { LocalCommandCall } from '../../types/command.js'
import { RESTART_DURING_TURN, restartAlreadyCurrentWords } from './words.js'

type RestartOutcome = { ok: true; line: string } | { ok: false; reason: string }

const STOP_SETTLE_MS = 20_000

export async function restartSessionOnInstalledBuild(args: {
  sessionId: string
  turnActive: boolean
  work: readonly WorkRowV1[]
  tell: (line: string) => void
  resume: (sessionId: string) => Promise<string | null>
}): Promise<RestartOutcome> {
  if (args.turnActive) return { ok: false, reason: RESTART_DURING_TURN }
  const { deployedRuntime } = await import('../../daemon/handover.js')
  const installed = deployedRuntime()
  if (installed === null || installed.buildTree === null) {
    return { ok: false, reason: 'no installed build to move onto — /restart moves a session onto the build that `mercury update` or a deploy installed' }
  }
  const tree = installed.buildTree
  const workers = await import('../../daemon/concourseWorkers.js')
  const standing = (): ReturnType<typeof workers.readSessionWorkers>[string] | undefined =>
    Object.values(workers.readSessionWorkers()).find(r => r.sessionId === args.sessionId && r.endedAt === undefined)
  const rec = standing()
  if (rec === undefined) return { ok: false, reason: 'no daemon record owns this chat, so there is no runner to move' }
  if (rec.buildTree === tree) return { ok: false, reason: restartAlreadyCurrentWords(tree) }
  const { endingWorkWords } = await import('../../tools/MonitorTool/watchReceipts.js')
  const ending = endingWorkWords(args.work)
  const { moveDaemonToDeployedBuild } = await import('../../daemon/handshake.js')
  const moved = await moveDaemonToDeployedBuild({ by: 'operator:/restart', runtime: installed })
  if (moved.state !== 'current' && moved.state !== 'moved') {
    return { ok: false, reason: `the session stays on its build: no daemon of the installed build (${tree}) is serving yet — ${moved.line}` }
  }
  args.tell(`Restarting this session on the installed build (${tree}) — this ends ${ending}`)
  const { isProcessAlive } = await import('../../daemon/ownerWatch.js')
  const runnerAlive = (r: { pid?: number }): boolean => r.pid !== undefined && isProcessAlive(r.pid)
  if (runnerAlive(rec)) {
    const { daemonControlRpc } = await import('../../daemon/controlSocket.js')
    const stop = (await daemonControlRpc(
      { op: 'sessionControl', action: 'stop', sessionId: args.sessionId, by: `operator:${process.pid}` } as never,
      { timeoutMs: 15_000 },
    )) as { ok?: boolean; outcome?: string; detail?: string; error?: string }
    if (stop.ok !== true || stop.outcome === 'refused') {
      return { ok: false, reason: `the session was not stopped, so it stays as it is — ${stop.detail ?? stop.error ?? 'the daemon refused the stop'}` }
    }
    const deadline = Date.now() + STOP_SETTLE_MS
    let settled = standing()
    while (settled !== undefined && (settled.stoppedAt === undefined || runnerAlive(settled)) && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 100))
      settled = standing()
    }
    if (settled === undefined) return { ok: false, reason: 'the session record left the board while it stopped — /sessions finds its transcript' }
    if (settled.stoppedAt === undefined || runnerAlive(settled)) {
      return { ok: false, reason: `the stop did not settle within ${STOP_SETTLE_MS / 1000} s — the board's ↵ resumes the session once it reads stopped` }
    }
  }
  const refusal = await args.resume(args.sessionId)
  if (refusal !== null) return { ok: false, reason: `the session stopped but did not resume on the installed build — ${refusal}; the board's ↵ resumes it` }
  return { ok: true, line: `Restarted on the installed build (${tree}) — ended: ${ending} · restart any watches or background commands you still need` }
}

export const call: LocalCommandCall = async () => {
  const slot = await import('../../services/engine-connector/focusedConnector.js')
  if (!slot.hasFocusedSession()) return { type: 'text', value: 'no session is focused — /restart moves the focused chat onto the installed build' }
  const focused = slot.getFocusedSessionConnector()
  const { mintImmediateReceipt } = await import('../../utils/model/seatReceipts.js')
  const { focusResumedSession } = await import('../../services/switchboard/hopIntoSession.js')
  const out = await restartSessionOnInstalledBuild({
    sessionId: focused.sessionId(),
    turnActive: focused.turnActive(),
    work: focused.workRoster().rows,
    tell: line => mintImmediateReceipt(line, 'warning'),
    resume: async sessionId => {
      const resumed = await focusResumedSession(sessionId, undefined, { restartReason: 'update' })
      return resumed.ok ? resumed.refusal : resumed.reason
    },
  })
  return { type: 'text', value: out.ok ? out.line : out.reason }
}
