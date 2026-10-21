import type { WorkRowV1 } from '../../services/engine-connector/types.js'
import type { LocalCommandCall } from '../../types/command.js'
import { RESTART_DURING_TURN, restartAlreadyCurrentWords } from './words.js'

type RestartOutcome = { ok: true; line: string } | { ok: false; reason: string }

const STOP_SETTLE_MS = 20_000

const INSTALLED_DAEMON_WAIT_ROUNDS = 40

export async function startInstalledDaemon(installed: import('../../daemon/handover.js').DeployedRuntimeV1): Promise<import('../../daemon/handshake.js').DaemonHandshakeVerdict> {
  const { handshakeDaemon } = await import('../../daemon/handshake.js')
  const { spawnOwnedDaemon } = await import('../../daemon/ownedDaemon.js')
  const { getCwd } = await import('../../utils/cwd.js')
  const { sameBuildTree } = await import('../../daemon/planeBoot.js')
  spawnOwnedDaemon(getCwd(), { label: 'switchboard', script: installed.script, ...(installed.node !== null ? { node: installed.node } : {}) })
  let verdict = await handshakeDaemon({ timeoutMs: 500 })
  for (let round = 0; round < INSTALLED_DAEMON_WAIT_ROUNDS && (verdict.daemon === null || verdict.state === 'starting' || !sameBuildTree(verdict.daemon.buildTree, installed.buildTree)); round++) {
    await new Promise(resolve => setTimeout(resolve, 250))
    verdict = await handshakeDaemon({ timeoutMs: 500 })
  }
  return verdict
}

export async function restartSessionOnInstalledBuild(args: {
  sessionId: string
  turnActive: boolean
  work: readonly WorkRowV1[]
  tell: (line: string) => void
  resume: (sessionId: string, reason?: 'update') => Promise<string | null>
  clear?: () => Promise<{ ok: true } | { ok: false; reason: string }>
  platform?: NodeJS.Platform
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
  const { sameBuildTree } = await import('../../daemon/planeBoot.js')
  const { runnerScriptOf, sameScript } = await import('../../daemon/runnerScript.js')
  const runnerScript = rec === undefined ? null : await runnerScriptOf(rec.pid, args.platform)
  if (sameScript(runnerScript, installed.script, args.platform)) return { ok: false, reason: restartAlreadyCurrentWords(tree) }
  const recordedTree = facts?.buildTree ?? rec?.buildTree
  if (runnerScript === null && typeof recordedTree === 'string' && sameBuildTree(recordedTree, tree)) return { ok: false, reason: restartAlreadyCurrentWords(tree) }
  if (rec === undefined) return { ok: false, reason: 'no daemon record owns this chat, so there is no runner to move' }
  if (runnerScript === null && recordedTree == null) return { ok: false, reason: 'this session runs a source build; /restart moves installed builds only' }
  const { moveDaemonToDeployedBuild, handshakeDaemon } = await import('../../daemon/handshake.js')
  if ((args.platform ?? process.platform) === 'win32') {
    const plane = await handshakeDaemon({ timeoutMs: 1500 })
    const others = plane.daemon === null ? 0 : Math.max(0, plane.liveSessions - 1)
    if (others > 0) {
      const { pipeHeldWords } = await import('../../daemon/handover.js')
      return { ok: false, reason: `this chat stays as it is — ${pipeHeldWords(others + 1)}; close the other ${others === 1 ? 'chat' : `${others} chats`} on this daemon, then /restart` }
    }
  }
  const { existsSync } = await import('node:fs')
  if (!existsSync(workers.concourseTranscriptPath(rec))) {
    if (args.clear === undefined) return { ok: false, reason: `this chat has not started yet, so there is nothing to move — a new chat starts on the installed build (${tree}) once the daemon has moved` }
    const movedBlank = await moveDaemonToDeployedBuild({ by: 'operator:/restart', runtime: installed, hosted: false }).catch(error => ({ state: 'unknown' as const, line: String(error) }))
    const servingBlank = movedBlank.state === 'absent' ? await startInstalledDaemon(installed) : await handshakeDaemon({ timeoutMs: 1000 })
    if (servingBlank.daemon === null || !sameBuildTree(servingBlank.daemon.buildTree, tree)) {
      return { ok: false, reason: `this chat has not started yet and stays as it is — no daemon of the installed build (${tree}) was serving within the handover wait: ${movedBlank.line}` }
    }
    const fresh = await args.clear()
    if (!fresh.ok) return { ok: false, reason: `this chat has not started yet and stays as it is — a fresh chat could not open on the installed build (${tree}): ${fresh.reason}` }
    return { ok: true, line: `This chat had not started yet, so nothing was moved: a fresh chat opened on the installed build (${tree}) in its place` }
  }
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
  const moved = await moveDaemonToDeployedBuild({ by: 'operator:/restart', runtime: installed, hosted: false }).catch(error => ({ state: 'unknown' as const, line: String(error) }))
  let serving = moved.state === 'absent' ? await startInstalledDaemon(installed) : await handshakeDaemon({ timeoutMs: 1000 })
  if (serving.state === 'absent') serving = await startInstalledDaemon(installed)
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
    clear: async () => {
      const { clearFocusedSession } = await import('../../services/switchboard/hopIntoSession.js')
      const cleared = await clearFocusedSession()
      return cleared.ok ? { ok: true } : { ok: false, reason: cleared.reason }
    },
  })
  return { type: 'text', value: out.ok ? out.line : out.reason }
}
