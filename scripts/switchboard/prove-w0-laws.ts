;(globalThis as Record<string, unknown>).MACRO = { VERSION: '0.0.0-prover' }

import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'switchboard-w0-home-'))
process.env.MERCURY_CONFIG_DIR = process.env.MERCURY_CONFIG_DIR
delete process.env.MERCURY_SESSION_HOME
delete process.env.MERCURY_SESSION_HOME

let failures = 0
let failWhere = ''
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  const shown = [detail, failWhere].filter(Boolean).join(' | ')
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && shown ? ` — ${shown}` : ''}`)
}

const { buildConcourseWorkerSpec } = await import('../../src/daemon/concourse-workers/concourseWorkers.js')
const { buildRunnerInvocation } = await import('../../src/daemon/runner-link/headlessRun.js')
const { workerTranscriptPath } = await import('../../src/screen/concourse-model/workerTranscript.js')
const { getProjectDir } = await import('../../src/sessions/transcripts/paths.js')
const { consumeSessionHomePin } = await import('../../src/sessions/transcripts/sessionHomePin.js')

const workspaceId = mkdtempSync(join(tmpdir(), 'switchboard-w0-ws-'))
const sessionId = '550e8400-e29b-41d4-a716-446655440000'
const spec = buildConcourseWorkerSpec({
  runnerId: 'concourse-w1',
  sessionId,
  workspaceId,
  modelKey: 'claude-fable-5',
  cwd: join(workspaceId, '.wt', 'concourse-w1'),
})

failWhere = 'fix buildRunnerInvocation in src/daemon/runner-link/headlessRun.ts (pin, --session-id and --resume argv), or workerTranscriptPath in src/screen/concourse-model/workerTranscript.ts if the reader path differs'
console.log('LAW 1 — one transcript home:')
const inv = buildRunnerInvocation(spec)
const pin = inv.env.MERCURY_SESSION_HOME
check('spec pins MERCURY_SESSION_HOME', typeof pin === 'string' && pin.length > 0)
check('pin equals the workspace project dir', pin === getProjectDir(workspaceId), `pin=${String(pin)}`)
check(
  'pinned home + sessionId equals the reader derivation byte-for-byte',
  join(String(pin), `${sessionId}.jsonl`) === workerTranscriptPath({ sessionId, workspaceId }),
)
const unwritten = buildRunnerInvocation(spec, { respawn: true })
check(
  'a respawn before the session wrote a transcript rides --session-id (never --resume of a conversation nobody wrote)',
  unwritten.argv.includes('--session-id') && unwritten.argv.includes(sessionId) && !unwritten.argv.includes('--resume'),
  unwritten.argv.join(' '),
)
mkdirSync(String(pin), { recursive: true })
writeFileSync(join(String(pin), `${sessionId}.jsonl`), `${JSON.stringify({ type: 'user', uuid: `${sessionId}-u1`, sessionId, message: { role: 'user', content: 'seeded turn' } })}\n`)
const respawn = buildRunnerInvocation(spec, { respawn: true })
check('respawn keeps the pin (spec-carried extraEnv)', respawn.env.MERCURY_SESSION_HOME === pin)
check(
  'respawn rides --resume of the SAME durable session',
  respawn.argv.includes('--resume') && respawn.argv.includes(sessionId),
)

failWhere = 'fix consumeSessionHomePin in src/sessions/transcripts/sessionHomePin.ts (it must read the pin once and scrub MERCURY_SESSION_HOME)'
console.log('LAW 1b — consume-once boot read:')
process.env.MERCURY_SESSION_HOME = '/tmp/switchboard-w0-pin-probe'
check('consume returns the pin', consumeSessionHomePin() === '/tmp/switchboard-w0-pin-probe')
check('env scrubbed after consume', process.env.MERCURY_SESSION_HOME === undefined)
check('second consume is null (plain boot)', consumeSessionHomePin() === null)

failWhere = 'fix buildRunnerInvocation in src/daemon/runner-link/headlessRun.ts (a concourse worker argv must carry no --crew, --seat or --seat-id and must pin --session-id)'
console.log('LAW 2 — identity sever:')
for (const flag of ['--crew', '--seat', '--seat-id']) {
  check(`concourse argv carries no ${flag}`, !inv.argv.includes(flag))
}
check(
  'concourse argv still pins the session id',
  inv.argv.includes('--session-id') && inv.argv.includes(sessionId),
)
failWhere = 'fix buildRunnerInvocation in src/daemon/runner-link/headlessRun.ts (the child env must stamp MERCURY_CONCOURSE_WORKER=1)'
console.log('LAW 3 — capacity role intact:')
check('MERCURY_CONCOURSE_WORKER stamps 1 on the child env', inv.env.MERCURY_CONCOURSE_WORKER === '1')

const { updateConcourseWorkers, attachYieldConcourseSession, detachRespawnConcourseSession, grantConcourseWorkflows, revokeConcourseWorkflows, sessionOwnedByLiveWorker, stopConcourseSession, readSessionWorkers } = await import('../../src/daemon/concourse-workers/concourseWorkers.js')
const { evaluateLaunchAuthority } = await import('../../src/daemon/switchboard/launchAuthority.js')

const recDir = mkdtempSync(join(tmpdir(), 'switchboard-w2-records-'))
const sid2 = '550e8400-e29b-41d4-a716-446655440001'
const sid3 = '550e8400-e29b-41d4-a716-446655440002'
const killed: string[] = []
const registered: string[] = []
const rosterStub = {
  kill: (short: string) => (killed.push(short), true),
  has: (_short: string) => ({ present: false }),
  registerLongLived: (short: string) => (registered.push(short), { ok: true, pid: 4242 }),
}
updateConcourseWorkers(ws => {
  ws['concourse-w1'] = {
    schema: 1, runnerId: 'concourse-w1', sessionId: sid2, workspaceId,
    isolation: 'worktree-isolated', modelKey: 'claude-fable-5',
    spawnedAt: 1, lastLiveAt: Date.now(), pid: process.pid,
    lastDeliveryAt: 10, lastTurnSettledAt: 20,
  }
  ws['concourse-w2'] = {
    schema: 1, runnerId: 'concourse-w2', sessionId: sid3, workspaceId,
    isolation: 'exclusive', modelKey: 'claude-fable-5',
    spawnedAt: 1, lastLiveAt: Date.now(),
  }
}, recDir)

failWhere = 'fix attachYieldConcourseSession or detachRespawnConcourseSession in src/daemon/concourse-workers/concourseWorkers.ts'
console.log('LAW 4 — attach/detach handover:')
const att = attachYieldConcourseSession(sid2, 'operator', rosterStub, recDir)
check('attach on a settled turn applies', att.outcome === 'applied')
check('attach killed the live child (intentional stop)', killed.includes('concourse-w1'))
check('attached session is owned (no foreign adoption)', sessionOwnedByLiveWorker(sid2, recDir) === 'concourse-w1')
check('second attach is a noop', attachYieldConcourseSession(sid2, 'operator', rosterStub, recDir).outcome === 'noop')
const det = detachRespawnConcourseSession(sid2, 'operator', rosterStub, recDir)
check('detach respawns the SAME worker short', det.outcome === 'applied' && det.runnerId === 'concourse-w1' && registered.includes('concourse-w1'))
check('detached session no longer attached-owned', sessionOwnedByLiveWorker(sid2, recDir) === null || sessionOwnedByLiveWorker(sid2, recDir) === 'concourse-w1')
check('detach on unattached is a noop', detachRespawnConcourseSession(sid2, 'operator', rosterStub, recDir).outcome === 'noop')

failWhere = 'fix stopConcourseSession or attachYieldConcourseSession in src/daemon/concourse-workers/concourseWorkers.ts (a refused kill must refuse with no-kill-channel and leave the record untouched)'
console.log('LAW 4b — no kill, no recorded death (the unverified-teardown class):')
{
  const sid4 = '550e8400-e29b-41d4-a716-446655440004'
  const sid5 = '550e8400-e29b-41d4-a716-446655440005'
  const { spawnSync } = await import('node:child_process')
  const deadPid = spawnSync('true').pid!
  updateConcourseWorkers(ws => {
    ws['concourse-w4'] = {
      schema: 1, runnerId: 'concourse-w4', sessionId: sid4, workspaceId,
      isolation: 'exclusive', modelKey: 'claude-fable-5',
      spawnedAt: 1, lastLiveAt: Date.now(), pid: process.pid,
      lastDeliveryAt: 10, lastTurnSettledAt: 20,
    }
    ws['concourse-w5'] = {
      schema: 1, runnerId: 'concourse-w5', sessionId: sid5, workspaceId,
      isolation: 'exclusive', modelKey: 'claude-fable-5',
      spawnedAt: 1, lastLiveAt: Date.now(), pid: deadPid,
    }
  }, recDir)
  const rosterMiss = { kill: (_short: string) => false }
  const stopMiss = stopConcourseSession(sid4, 'operator x', rosterMiss, recDir)
  check('stop with a refused kill is a typed refusal', stopMiss.outcome === 'refused' && 'reason' in stopMiss && stopMiss.reason === 'no-kill-channel')
  check('the refused stop left the record live (no stoppedAt)', readSessionWorkers(recDir)['concourse-w4']!.stoppedAt === undefined)
  const stopNoRoster = stopConcourseSession(sid4, 'operator x', undefined, recDir)
  check('stop with NO roster is a typed refusal', stopNoRoster.outcome === 'refused')
  const attMiss = attachYieldConcourseSession(sid4, 'operator', { ...rosterStub, kill: (_s: string) => false }, recDir)
  check('attach with a refused kill is a typed refusal (no handover over a live child)', attMiss.outcome === 'refused' && 'reason' in attMiss && attMiss.reason === 'no-kill-channel')
  check('the refused attach left the record unattached', readSessionWorkers(recDir)['concourse-w4']!.attachedAt === undefined)
  const stopDead = stopConcourseSession(sid5, 'operator x', undefined, recDir)
  check('stop of an already-dead child applies honestly without a roster', stopDead.outcome === 'applied')
}

failWhere = 'fix grantConcourseWorkflows or revokeConcourseWorkflows in src/daemon/concourse-workers/concourseWorkers.ts (only one session may hold the tag)'
console.log('LAW 5 — the ONE crewmates-allowed tag:')
check('grant applies', grantConcourseWorkflows(sid2, 'operator', recDir).outcome === 'applied')
const second = grantConcourseWorkflows(sid3, 'operator', recDir)
check('second grant refused in plain words (cap-one)', second.outcome === 'refused' && 'reason' in second && second.reason === 'cap-one')
check('revoke applies', revokeConcourseWorkflows(sid2, 'operator', recDir).outcome === 'applied')
check('grant after revoke applies elsewhere', grantConcourseWorkflows(sid3, 'operator', recDir).outcome === 'applied')

failWhere = 'fix evaluateLaunchAuthority in src/daemon/switchboard/launchAuthority.ts'
console.log('LAW 6 — the launch-authority valve:')
check('interactive process (no role env) may launch', evaluateLaunchAuthority('subagents', { roleEnvOn: false }).allowed === true)
delete process.env.MERCURY_CONCOURSE_WORKER
delete process.env.MERCURY_CONCOURSE_WORKER
check('the unprobed read is lawful for the value-kind role flag', evaluateLaunchAuthority('subagents').allowed === true)
check('background child WITHOUT the tag is refused', evaluateLaunchAuthority('subagents', { roleEnvOn: true, dir: recDir, sessionId: sid2 }).allowed === false)
check('background child WITH the tag may launch', evaluateLaunchAuthority('subagents', { roleEnvOn: true, dir: recDir, sessionId: sid3 }).allowed === true)
const refusal = evaluateLaunchAuthority('subagents', { roleEnvOn: true, dir: recDir, sessionId: sid2 })
check('refusal names the wait-until-visited law', refusal.allowed === false && refusal.reason.includes('backgrounded'))

failWhere = 'fix holdWorkerAsk or answerPermissionAsk in src/daemon/session-seat/permissionAsks.ts, or the runner argv and capabilities from buildRunnerInvocation in src/daemon/runner-link/headlessRun.ts'
console.log('LAW 7 — the ask-wire (Q2):')
check(
  'the spawn serves the runner door and the daemon holds its asks',
  inv.argv[1] === 'runner' && !inv.argv.some(word => word.startsWith('--permission')) && inv.capabilities.holds_asks === true,
)
check('the respawn keeps the door', respawn.argv[1] === 'runner' && respawn.capabilities.holds_asks === true)
const { holdWorkerAsk, answerPermissionAsk, listPendingPermissionAsks } = await import(
  '../../src/daemon/session-seat/permissionAsks.js'
)
type Answer = import('../../src/daemon/runner-wire/methods.js').PermissionAnswer
const allowHeld = holdWorkerAsk('concourse-w1', { kind: 'tool', tool_use_id: 'tu-allow-1', tool_name: 'Bash', input: { command: 'echo hi' } }, recDir, 60_000, () => 'attached')
const allowId = listPendingPermissionAsks().at(-1)?.requestId ?? ''
const denyHeld = holdWorkerAsk('concourse-w1', { kind: 'tool', tool_use_id: 'tu-deny-1', tool_name: 'Write', input: { file_path: '/x' } }, recDir, 60_000, () => 'attached')
const denyId = listPendingPermissionAsks().at(-1)?.requestId ?? ''
check('asks parked as pending', listPendingPermissionAsks().length === 2 && allowId !== denyId)
const settled = (answer: Promise<Answer>): Promise<Answer | null> => Promise.race([answer, new Promise<null>(r => setTimeout(() => r(null), 1_000))])
const allowRes = answerPermissionAsk(allowId, true, 'operator')
check('allow answer applies', allowRes.outcome === 'applied')
const allowAnswer = await settled(allowHeld.answer)
check(
  "the allow resolves the runner's request typed, with no edited input (the runner keeps its original — the permission contract)",
  allowAnswer?.outcome === 'allow' && allowAnswer.input === undefined,
  JSON.stringify(allowAnswer),
)
const denyRes = answerPermissionAsk(denyId, false, 'operator')
const denyAnswer = await settled(denyHeld.answer)
check(
  'deny answer carries a plain refusal',
  denyRes.outcome === 'applied' && denyAnswer?.outcome === 'deny' && typeof denyAnswer.message === 'string',
  JSON.stringify(denyAnswer),
)
check(
  'answered ask is unknown on a second answer',
  answerPermissionAsk(allowId, true, 'operator').outcome === 'refused',
)

failWhere = 'fix focusDaemonSession in src/engine/connector/daemonConnector.ts or the focused slot in src/engine/connector/focusedConnector.ts (the window must only read the transcript, never write it)'
console.log('WINDOW LAW — a window paints the view lane, never writes:')
{
  const { readFileSync, writeFileSync, appendFileSync, readdirSync, mkdirSync, statSync } = await import('node:fs')
  const windowHome = mkdtempSync(join(tmpdir(), 'switchboard-window-home-'))
  const windowDir = join(windowHome, 'projects', 'scratch-ws')
  mkdirSync(windowDir, { recursive: true })
  const fsid = 'aaaaaaaa-1111-4222-8333-444444444444'
  const fpath = join(windowDir, `${fsid}.jsonl`)
  const { encodeTranscriptLine } = await import('../../src/sessions/transcripts/vnext.js')
  const line = (uuid: string, parentUuid: string | null, role: 'user' | 'assistant', text: string, ts: string): string =>
    encodeTranscriptLine(fpath, {
      type: role,
      uuid,
      parentUuid,
      isSidechain: false,
      sessionId: fsid,
      timestamp: ts,
      cwd: '/scratch',
      version: '0.0.0',
      message:
        role === 'user'
          ? { role: 'user', content: [{ type: 'text', text }] }
          : { role: 'assistant', model: 'claude-fable-5', id: `msg_${uuid.slice(0, 8)}`, type: 'message', content: [{ type: 'text', text }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } },
    }).line
  writeFileSync(
    fpath,
    line('11111111-1111-4111-8111-111111111111', null, 'user', 'first prompt', '2026-08-16T13:00:00.000Z') +
      line('22222222-2222-4222-8222-222222222222', '11111111-1111-4111-8111-111111111111', 'assistant', 'first reply', '2026-08-16T13:00:01.000Z'),
  )
  const snapshotTree = (): string =>
    JSON.stringify(
      readdirSync(windowHome, { recursive: true })
        .map(String)
        .sort()
        .map(p => {
          const st = statSync(join(windowHome, p))
          return [p, st.isFile() ? st.size : 'dir']
        }),
    )
  const bytesBefore = readFileSync(fpath)
  const treeBefore = snapshotTree()
  const seat = await import('../../src/engine/connector/daemonConnector.js')
  const slot = await import('../../src/engine/connector/focusedConnector.js')
  const focusedLens: number[] = []
  const subscribeFocusedRecords = slot.subscribeThroughFocused((c, l) => c.subscribeRecords(l))
  const unsubscribe = subscribeFocusedRecords(() => {
    focusedLens.push(slot.getFocusedSessionConnector().records().length)
  })
  const connector = await seat.focusDaemonSession({
    sessionId: fsid,
    runnerId: 'concourse-wF',
    title: 'seat probe',
    projectLabel: 'scratch-ws',
    workspaceId: '/scratch-ws',
    home: windowDir,
  })
  check('the hop re-points the focused slot at the session', slot.getFocusedSessionConnector() === connector && connector.sessionId() === fsid)
  check('the first paint delivered the hydrated chain through the connector', connector.records().length === 2, `records=${connector.records().length}`)
  appendFileSync(
    fpath,
    line('33333333-3333-4333-8333-333333333333', '22222222-2222-4222-8222-222222222222', 'user', 'second prompt', '2026-08-16T13:00:02.000Z') +
      line('44444444-4444-4444-8444-444444444444', '33333333-3333-4333-8333-333333333333', 'assistant', 'second reply', '2026-08-16T13:00:03.000Z'),
  )
  const bytesGrown = readFileSync(fpath)
  const treeGrown = snapshotTree()
  const repaintDeadline = Date.now() + 2500
  while (Date.now() < repaintDeadline && connector.records().length < 4) {
    await new Promise(r => setTimeout(r, 50))
  }
  check('a growing file repaints (the records are never static)', connector.records().length === 4, `record lengths seen=${JSON.stringify(focusedLens)}`)
  await new Promise(r => setTimeout(r, 900))
  check('the session\'s transcript is byte-identical after the paints', readFileSync(fpath).equals(bytesGrown))
  check('no file appeared or grew anywhere under the scratch home', snapshotTree() === treeGrown, `${treeBefore} -> ${snapshotTree()}`)
  check('the pre-append bytes are a strict prefix (the reader never rewrites)', bytesGrown.subarray(0, bytesBefore.length).equals(bytesBefore))
  slot.releaseFocusedSessionConnector()
  check('closing the chat leaves the seat and rests the slot (nothing returns to an engine)', slot.getFocusedSessionConnector() !== connector && !slot.hasFocusedSession())
  check('the connector that lost the slot stopped its feeds', await (async () => {
    const t0 = Date.now()
    while (Date.now() - t0 < 2000 && connector.isAttached()) await new Promise(r => setTimeout(r, 50))
    return !connector.isAttached()
  })())
  unsubscribe()
}


failWhere = 'fix the cancel handler in src/screen/chat/interruptKeys.ts or the keys wiring in src/screen/chat/ChatKeys.tsx (focusedTurnActive must follow the seat in-flight state)'
console.log("\n§ the cancel handler and the focused turn, read off the mounted keys of the chat screen")
{
  const { openKeysPart } = await import('../ui/chatScenarios.ts')
  const { IDLE_LIVE } = await import('../../src/engine/connector/seatLive.js')
  const keys = await openKeysPart('switchboard-w0-keys', { keepHome: true })
  await keys.plant({ seatLive: { ...IDLE_LIVE, inFlight: true } })
  const inFlight = keys.handed.cancel?.focusedTurnActive
  await keys.plant({ seatLive: IDLE_LIVE })
  check('the cancel handler reaches the focused turn', inFlight === true && keys.handed.cancel?.focusedTurnActive === false, `${String(inFlight)} then ${String(keys.handed.cancel?.focusedTurnActive)}`)
  await keys.close()
}

console.log(
  failures === 0 ? '\nprove-w0-laws: ALL LAWS HOLD' : `\nprove-w0-laws: ${failures} FAILURE(S)`,
)
process.exit(failures === 0 ? 0 : 1)
