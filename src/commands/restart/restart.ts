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
  resume: (sessionId: string, reason?: 'update') => Promise<string | null>
}): Promise<RestartOutcome> {
  if (args.turnActive) return { ok: false, reason: RESTART_DURING_TURN }
  const { readSessionFacts } = await import('../../services/engine-connector/seatProjections.js')
  const facts = readSessionFacts(args.sessionId)
  if (facts?.buildTree === null) return { ok: false, reason: 'this session runs a source build; /restart moves installed builds only' }
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
  const runningTree = facts?.buildTree ?? rec?.buildTree
  const { sameBuildTree } = await import('../../daemon/planeBoot.js')
  if (typeof runningTree === 'string' && sameBuildTree(runningTree, tree)) return { ok: false, reason: restartAlreadyCurrentWords(tree) }
  if (rec === undefined) return { ok: false, reason: 'no daemon record owns this chat, so there is no runner to move' }
  if (runningTree == null) return { ok: false, reason: 'this session runs a source build; /restart moves installed builds only' }
  const { endingWorkWords } = await import('../../tools/MonitorTool/watchReceipts.js')
  const ending = endingWorkWords(args.work)
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
  const { moveDaemonToDeployedBuild, handshakeDaemon } = await import('../../daemon/handshake.js')
  const moved = await moveDaemonToDeployedBuild({ by: 'operator:/restart', runtime: installed, hosted: false }).catch(error => ({ state: 'unknown' as const, line: String(error) }))
  let serving = await handshakeDaemon({ timeoutMs: 1000 })
  if (serving.state === 'absent') {
    const { ensureOwnedDaemon } = await import('../../services/switchboard/ensureDaemon.js')
    await ensureOwnedDaemon()
    serving = await handshakeDaemon({ timeoutMs: 1000 })
  }
  if (serving.daemon === null || !sameBuildTree(serving.daemon.buildTree, tree)) {
    const restored = await args.resume(args.sessionId)
    return { ok: false, reason: restored === null
      ? `the installed build (${tree}) was not serving within the handover wait; the session resumed on the available daemon — ${moved.line} · ended: ${ending} · re-arm what you still want`
      : `the session stopped but no daemon of the installed build (${tree}) was serving within the handover wait — ${moved.line}; resume also refused: ${restored}; the board's ↵ resumes it` }
  }
  const refusal = await args.resume(args.sessionId, 'update')
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
    resume: async (sessionId, restartReason) => {
      const resumed = await focusResumedSession(sessionId, undefined, { restartReason })
      return resumed.ok ? resumed.refusal : resumed.reason
    },
  })
  return { type: 'text', value: out.ok ? out.line : out.reason }
}
