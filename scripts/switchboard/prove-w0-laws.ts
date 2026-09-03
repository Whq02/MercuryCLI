// ============================================================================
//  prove-w0-laws — the switchboard session-home domain prover.
//
//  Law 1 (transcript home): the spawn spec pins MERCURY_SESSION_HOME to the
//  WORKSPACE's project dir; the pinned home equals the reader's derivation
//  (workerTranscriptPath) byte-for-byte; the pin survives respawn; the
//  consume-once boot read scrubs the env so grandchildren never inherit it.
//  Law 2 (identity sever): a concourse invocation carries NO mailbox triplet
//  (the teammate/greeting chain structurally cannot arm) while crew-shaped
//  specs still carry it (control).
//  Law 3 (capacity intact): the role env MERCURY_CONCOURSE_WORKER still
//  stamps '1' on the child env (the background ceiling keys on it).
// ============================================================================
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '0.0.0-prover' }

import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'switchboard-w0-home-'))
process.env.MERCURY_CONFIG_DIR = process.env.MERCURY_CONFIG_DIR
delete process.env.MERCURY_SESSION_HOME
delete process.env.MERCURY_SESSION_HOME

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}

const { buildConcourseWorkerSpec } = await import('../../src/daemon/concourseSupervisor.js')
const { buildStreamJsonInvocation } = await import('../../src/daemon/headlessRun.js')
const { workerTranscriptPath } = await import('../../src/services/concourse/workerTranscript.js')
const { getProjectDir } = await import('../../src/utils/sessionStorage/paths.js')
const { consumeSessionHomePin } = await import('../../src/utils/sessionStorage/sessionHomePin.js')

const workspaceId = mkdtempSync(join(tmpdir(), 'switchboard-w0-ws-'))
const sessionId = '550e8400-e29b-41d4-a716-446655440000'
const spec = buildConcourseWorkerSpec({
  runnerId: 'concourse-w1',
  sessionId,
  workspaceId,
  modelKey: 'claude-fable-5',
  cwd: join(workspaceId, '.wt', 'concourse-w1'), // the carved-worktree shape
})

console.log('LAW 1 — one transcript home:')
const inv = buildStreamJsonInvocation(spec)
const pin = inv.env.MERCURY_SESSION_HOME
check('spec pins MERCURY_SESSION_HOME', typeof pin === 'string' && pin.length > 0)
check('pin equals the workspace project dir', pin === getProjectDir(workspaceId), `pin=${String(pin)}`)
check(
  'pinned home + sessionId equals the reader derivation byte-for-byte',
  join(String(pin), `${sessionId}.jsonl`) === workerTranscriptPath({ sessionId, workspaceId }),
)
const respawn = buildStreamJsonInvocation(spec, { respawn: true })
check('respawn keeps the pin (spec-carried extraEnv)', respawn.env.MERCURY_SESSION_HOME === pin)
check(
  'respawn rides --resume of the SAME durable session',
  respawn.argv.includes('--resume') && respawn.argv.includes(sessionId),
)

console.log('LAW 1b — consume-once boot read:')
process.env.MERCURY_SESSION_HOME = '/tmp/switchboard-w0-pin-probe'
check('consume returns the pin', consumeSessionHomePin() === '/tmp/switchboard-w0-pin-probe')
check('env scrubbed after consume', process.env.MERCURY_SESSION_HOME === undefined)
check('second consume is null (plain boot)', consumeSessionHomePin() === null)

console.log('LAW 2 — identity sever:')
for (const flag of ['--team-name', '--agent-name', '--agent-id']) {
  check(`concourse argv carries no ${flag}`, !inv.argv.includes(flag))
}
check(
  'concourse argv still pins the session id',
  inv.argv.includes('--session-id') && inv.argv.includes(sessionId),
)
const crewInv = buildStreamJsonInvocation({
  model: 'claude-fable-5',
  effort: 'high',
  appendSystemPrompt: '',
  role: 'MERCURY_CREW',
  agentName: 'probe',
  agentId: 'probe@crew',
  teamName: 'crew',
})
check(
  'crew-shaped spec still carries the triplet (control)',
  crewInv.argv.includes('--team-name') &&
    crewInv.argv.includes('--agent-name') &&
    crewInv.argv.includes('--agent-id'),
)

console.log('LAW 3 — capacity role intact:')
check('MERCURY_CONCOURSE_WORKER stamps 1 on the child env', inv.env.MERCURY_CONCOURSE_WORKER === '1')

// ── W2/W3 laws (attach/detach handover · workflows-allowed tag · the
//    launch-authority valve) — over a SCRATCH records dir + a stub roster.
const { updateConcourseWorkers, attachYieldConcourseSession, detachRespawnConcourseSession, grantConcourseWorkflows, revokeConcourseWorkflows, sessionOwnedByLiveWorker, stopConcourseSession, readSessionWorkers } = await import('../../src/daemon/concourseSupervisor.js')
const { evaluateLaunchAuthority } = await import('../../src/services/switchboard/launchAuthority.js')

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

console.log('LAW 4b — no kill, no recorded death (the unverified-teardown class):')
{
  // A LIVE child whose kill cannot be dispatched (roster lost the short, or
  // no roster at all) must never be recorded stopped ("child dead by
  // intent") or attached ("child dead by handover") — the record left
  // stopped would release the workspace claim beside a running process.
  const sid4 = '550e8400-e29b-41d4-a716-446655440004'
  const sid5 = '550e8400-e29b-41d4-a716-446655440005'
  const { spawnSync } = await import('node:child_process')
  const deadPid = spawnSync('true').pid! // reaped by return: a provably dead pid
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

console.log('LAW 5 — the ONE workflows-allowed tag:')
check('grant applies', grantConcourseWorkflows(sid2, 'operator', recDir).outcome === 'applied')
const second = grantConcourseWorkflows(sid3, 'coordinator', recDir)
check('second grant refused in plain words (cap-one)', second.outcome === 'refused' && 'reason' in second && second.reason === 'cap-one')
check('revoke applies', revokeConcourseWorkflows(sid2, 'operator', recDir).outcome === 'applied')
check('grant after revoke applies elsewhere', grantConcourseWorkflows(sid3, 'operator', recDir).outcome === 'applied')

console.log('LAW 6 — the launch-authority valve:')
check('interactive process (no role env) may launch', evaluateLaunchAuthority('workflows', { roleEnvOn: false }).allowed === true)
// Regression pin (the render-error class): the UNPROBED path must read the
// VALUE-kind role flag lawfully — flagEnabled() on it crashed the app root.
delete process.env.MERCURY_CONCOURSE_WORKER
delete process.env.MERCURY_CONCOURSE_WORKER
check('the unprobed read is lawful for the value-kind role flag', evaluateLaunchAuthority('workflows').allowed === true)
check('background child WITHOUT the tag is refused', evaluateLaunchAuthority('workflows', { roleEnvOn: true, dir: recDir, sessionId: sid2 }).allowed === false)
check('background child WITH the tag may launch', evaluateLaunchAuthority('subagents', { roleEnvOn: true, dir: recDir, sessionId: sid3 }).allowed === true)
const refusal = evaluateLaunchAuthority('subagents', { roleEnvOn: true, dir: recDir, sessionId: sid2 })
check('refusal names the wait-until-visited law', refusal.allowed === false && refusal.reason.includes('backgrounded'))

console.log('LAW 7 — the ask-wire (Q2):')
check(
  'spawn argv carries --permission-prompt-tool stdio',
  inv.argv.includes('--permission-prompt-tool') && inv.argv.includes('stdio'),
)
check('respawn argv keeps the wire', respawn.argv.includes('--permission-prompt-tool'))
const { onWorkerControlRequest, answerPermissionAsk, listPendingPermissionAsks } = await import(
  '../../src/daemon/permissionAsks.js'
)
type ControlFrame = {
  type?: string
  response?: {
    request_id?: string
    subtype?: string
    response?: { behavior?: string; updatedInput?: { command?: string }; message?: string }
  }
}
onWorkerControlRequest(
  'concourse-w1',
  {
    type: 'control_request',
    request_id: 'req-allow-1',
    request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'echo hi' } },
  },
  recDir,
)
onWorkerControlRequest(
  'concourse-w1',
  {
    type: 'control_request',
    request_id: 'req-deny-1',
    request: { subtype: 'can_use_tool', tool_name: 'Write', input: { file_path: '/x' } },
  },
  recDir,
)
check('asks parked as pending', listPendingPermissionAsks().length === 2)
const controlFrames: Array<{ short: string; frame: string }> = []
const controlRoster = {
  control: (short: string, frame: string) => (controlFrames.push({ short, frame }), true),
}
const allowRes = answerPermissionAsk('req-allow-1', true, controlRoster, 'operator')
check('allow answer applies', allowRes.outcome === 'applied')
const allowFrame = JSON.parse(controlFrames[0]?.frame ?? '{}') as ControlFrame
check(
  'allow frame echoes the ORIGINAL input (permission-tool contract)',
  allowFrame.type === 'control_response' &&
    allowFrame.response?.request_id === 'req-allow-1' &&
    allowFrame.response?.subtype === 'success' &&
    allowFrame.response?.response?.behavior === 'allow' &&
    allowFrame.response?.response?.updatedInput?.command === 'echo hi',
)
const denyRes = answerPermissionAsk('req-deny-1', false, controlRoster, 'operator')
const denyFrame = JSON.parse(controlFrames[1]?.frame ?? '{}') as ControlFrame
check(
  'deny answer carries a plain refusal',
  denyRes.outcome === 'applied' &&
    denyFrame.response?.response?.behavior === 'deny' &&
    typeof denyFrame.response?.response?.message === 'string',
)
check(
  'answered ask is unknown on a second answer',
  answerPermissionAsk('req-allow-1', true, controlRoster, 'operator').outcome === 'refused',
)

// ── A HOP is a READ ──────
//  The session's connector reads the board session's transcript and the
//  focused slot re-points at it; the in-process engine's transcript writer
//  records ITS lane only, so nothing the boot session produces while
//  another session is focused is lost and nothing the hop shows is ever
//  written anywhere. Two pins:
//   · engine: the hop → the connector carries the hydrated chain · the
//     engine lane is untouched · the session's file byte-identical · no file
//     appears anywhere under the scratch home · a growing file REPAINTS ·
//     releasing the slot returns the in-process engine, its lane whole;
//   · REPL seam: useLogMessages takes the engine lane; the store's render
//     projection prefers the view lane while set; the cancel handler
//     stands down under a window.
console.log('WINDOW LAW — a window paints the view lane, never writes:')
{
  const { readFileSync, writeFileSync, appendFileSync, readdirSync, mkdirSync, statSync } = await import('node:fs')
  const windowHome = mkdtempSync(join(tmpdir(), 'switchboard-window-home-'))
  const windowDir = join(windowHome, 'projects', 'scratch-ws')
  mkdirSync(windowDir, { recursive: true })
  const fsid = 'aaaaaaaa-1111-4222-8333-444444444444'
  const fpath = join(windowDir, `${fsid}.jsonl`)
  // The fixture is encoded through the REAL writer's encoder (the transcript
  // reader accepts the record format only — the header line, versioned
  // envelopes, string ordinals; a raw-line fixture reads as empty).
  const { encodeTranscriptLine } = await import('../../src/utils/sessionStorage/vnext.js')
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
  // THE SEAT (the concourse trio's wire step): the session's connector reads
  // its file; re-pointing the focused slot at it is the hop. The same laws
  // the window carried hold through the new shape: the first paint hydrates
  // the chain, a growing file repaints, the read never writes, and closing
  // the chat leaves the seat (the one-door law: the slot rests on no
  // session — the "engine lane" the screen once kept is gone, the dead
  // transcript store retired with the ghost chat).
  const seat = await import('../../src/services/engine-connector/daemonConnector.js')
  const slot = await import('../../src/services/engine-connector/focusedConnector.js')
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
  // The file grows (the runner lands its next thought) — the focused chat must repaint.
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
  // Let a few idle heartbeats pass — nothing may be written by the READ.
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
  // The REPL seam (source pins — the writer reads the engine lane; the chat
  // renders the focused connector's records; esc reaches the focused turn).
  const replSrc = readFileSync(join(import.meta.dirname, '../../src/screens/REPL.tsx'), 'utf8')
  // The screen holds no writer and no engine lane: every session's runner
  // records its own transcript; the face renders the focused records only.
  check('the screen holds no transcript writer', !replSrc.includes('useLogMessages'))
  check('the REPL renders the focused records and no engine lane', replSrc.includes('const messages = useFocusedTranscript();') && !replSrc.includes('useEngineTranscriptMessages'))
  check('the cancel handler reaches the focused turn', replSrc.includes('focusedTurnActive: seatLive.inFlight,'))
  check('no engine dialog of the screen\'s own exists to hold off-screen (the sandbox queue is the session runner\'s)', !replSrc.includes('sandboxPermissionQueue'))
  check('the consent card is the FOCUSED chat\'s', replSrc.includes('toolUseConfirmQueueLength: toolUseConfirmQueue.length'))
  // A4: the screen-side transcript store had ZERO writers
  // and the telemetry bus listened to a lane nothing wrote — the dead organ
  // retired with the ghost; the bus rides the FOCUSED records door now.
  check('the dead transcript store is gone (no screen-side engine lane exists)', !existsSync(join(import.meta.dirname, '../../src/state/transcriptStore.ts')))
  const busSrc = readFileSync(join(import.meta.dirname, '../../src/state/telemetryBus.ts'), 'utf8')
  check('the telemetry bus rides the focused records door (never a lane nothing writes)', busSrc.includes('subscribeThroughFocused((connector, listener) => connector.subscribeRecords(listener))') && !busSrc.includes('transcriptStore'))
  const hookSrc = readFileSync(join(import.meta.dirname, '../../src/hooks/useLogMessages.ts'), 'utf8')
  check(
    'useLogMessages returns before recordTranscript when ignored',
    hookSrc.indexOf('if (ignore) return') !== -1 && hookSrc.indexOf('if (ignore) return') < hookSrc.indexOf('void recordTranscript('),
  )
}

// ── Drive-12: the seamless-enter laws ─────
console.log('\n§ drive-12 — the live view, the one lift, the stale-tag law, PAUSED honesty, the consolidate brief')
{
  const replSrc = readFileSync(join(import.meta.dirname, '../../src/screens/REPL.tsx'), 'utf8')
  const seatSrc = readFileSync(join(import.meta.dirname, '../../src/services/engine-connector/daemonConnector.ts'), 'utf8')
  // The LIVE view: the connector paints raw records (in-flight tool_use +
  // tail thinking stay), no resume synthesis — deserializeLiveMessages,
  // never deserializeMessages — and folds the ONE thinking lift from them.
  check('the connector paints the LIVE deserializer (no resume synthesis)', seatSrc.includes('deserializeLiveMessages(') && !seatSrc.includes('deserializeMessages('))
  check('the connector folds the ONE thinking lift from its records (the incremental fold over its own chain)', seatSrc.includes('createLiveTurnFold()') && seatSrc.includes('this.liveFold.fold(this.rawRecords, chain.since)'))
  check('the REPL paints the lift from the focused connector (the one loading truth)', replSrc.includes('const isLoading = seatLive.inFlight;') && replSrc.includes('viewInProgressToolUseIDs'))
  // The stale-tag law: the hop hands the record's model + effort to the
  // connector and the frame band names the focused session's OWN model.
  check('the hop carries model + effort from the record', seatSrc.includes('modelKey?: string') && seatSrc.includes('effort?: string'))
  check("the frame band names the focused session's model", replSrc.includes('<MercuryFrame model={focusedEffectiveModel} />'))
  // Line 4 (its own numbers) reaches the TELEMETRY rail too: the spend
  // glance reads the focused connector's own usage, never the process
  // ledger under a hop (the $2.54-under-Alpha class).
  const railSrc = readFileSync(join(import.meta.dirname, '../../src/components/HelmLanesRail.tsx'), 'utf8')
  check("the rail's spend glance reads the FOCUSED connector's own usage", railSrc.includes('const focusedUsage = getFocusedSessionConnector().usage()') && railSrc.includes('focusedUsage.totalCostUSD'))
  check("the rail's spend glance no longer prints the process ledger's number", !railSrc.includes('glanceUsage.spend.costUSD.toFixed'))
  const hopSrc = readFileSync(join(import.meta.dirname, '../../src/services/switchboard/hopIntoSession.ts'), 'utf8')
  const routeSrc = readFileSync(join(import.meta.dirname, '../../src/components/concourse/ConcourseRoute.tsx'), 'utf8')
  check('the hop hands the record model/effort to the connector', hopSrc.includes('{ modelKey: rec.modelKey }') && hopSrc.includes('{ effort: rec.effort }'))
  // Nothing yielded: the enter path never calls the attach door.
  check('the enter never yields the runner (no attach RPC on the enter path)', !routeSrc.includes("action: 'attach'") && !hopSrc.includes("action: 'attach'"))
  // PAUSED honesty: the enter valve is its own field; the state fold never
  // reads it; resume/detach clear it; the delivery valve honors it.
  const supSrc = readFileSync(join(import.meta.dirname, '../../src/daemon/concourseSupervisor.ts'), 'utf8')
  const yieldStart = supSrc.indexOf('export function attachYieldConcourseSession(')
  const yieldBody = supSrc.slice(yieldStart, supSrc.indexOf('\n}\n', yieldStart))
  check('attachYield stamps the ENTER valve, never pausedAt', yieldBody.includes('rec.attachRequestedAt = Date.now()') && !yieldBody.includes('rec.pausedAt = Date.now()'))
  const resumeStart = supSrc.indexOf('export function resumeConcourseWorker(')
  const resumeBody = supSrc.slice(resumeStart, supSrc.indexOf('\n}\n', resumeStart))
  check('resume re-opens BOTH valves', resumeBody.includes('delete rec.attachRequestedAt') && resumeBody.includes('delete rec.pausedAt'))
  const snapSrc = readFileSync(join(import.meta.dirname, '../../src/services/concourse/concourseSnapshot.ts'), 'utf8')
  const stateStart = snapSrc.indexOf('export function concourseRecordState(')
  const stateBody = snapSrc.slice(stateStart, snapSrc.indexOf('\n}\n', stateStart))
  const stateCode = stateBody.split('\n').filter(l => !l.trim().startsWith('//') && !l.trim().startsWith('*')).join('\n')
  check('concourseRecordState never paints PAUSED from the enter valve', !stateCode.includes('attachRequestedAt') && stateCode.includes("rec.pausedAt !== undefined"))
  const dispSrc = readFileSync(join(import.meta.dirname, '../../src/daemon/concourseDispatch.ts'), 'utf8')
  check('the delivery valve holds with-you on the enter valve too', dispSrc.includes("(targetRec.attachedAt !== undefined || targetRec.attachRequestedAt !== undefined)"))
  // The consolidate brief names WHERE the work is.
  const kernelSrc = readFileSync(join(import.meta.dirname, '../../src/services/concourse/coordinatorKernel.ts'), 'utf8')
  check('the merge-back brief names the worktree path + commit state', kernelSrc.includes('worktree ${r.worktreePath}') && kernelSrc.includes('uncommitted file(s) in the worktree'))
  // The coordinator's input: with-you rows are LIVE; rows carry runner/where.
  // The board input's ONE owner is coordinatorBoard.ts (the whole-world
  // view the coordinator-prompting fold landed): with-you rows count as
  // live, and every row carries where/what/how (means, now, branch,
  // worktree, commits, model, effort).
  const laneSrc = readFileSync(join(import.meta.dirname, '../../src/services/concourse/coordinatorLane.ts'), 'utf8')
  const boardSrc = readFileSync(join(import.meta.dirname, '../../src/services/concourse/coordinatorBoard.ts'), 'utf8')
  const countsAt = boardSrc.indexOf('counts.sessions = ')
  const attachedCase = boardSrc.slice(boardSrc.indexOf("case 'attached':", countsAt), boardSrc.indexOf("case 'working':", countsAt))
  check("the board input counts WITH-YOU sessions as live", attachedCase.includes('counts.withYou') && attachedCase.includes('counts.live'))
  check('board rows carry means + now + model + effort + branch + worktree + commits', ['means', 'now?:', 'branch?:', 'worktree?:', 'commits?:', 'model?:', 'effort?:'].every(n => boardSrc.includes(n)))
  check('receipt labels have ONE home and never lead with a 36-char id', laneSrc.includes('receiptLabelOf(') && !laneSrc.includes('`${r.verb} ${r.objectRef} — ${r.outcome}'))
  check('the empty-reply fallback is honest (no fabricated "nothing needed doing")', !laneSrc.includes("'Nothing needed doing — the board already reflects that.'"))
  const callSrc = readFileSync(join(import.meta.dirname, '../../src/services/concourse/coordinatorCall.ts'), 'utf8')
  check('the tool loop keeps a closing text round after the last tool call', callSrc.includes('round <= COORDINATOR_TURN_MAX_TOOL_CALLS + 1'))
  // The mirror shows a working session's life.
  const mirrorSrc = readFileSync(join(import.meta.dirname, '../../src/components/concourse/SessionMirror.tsx'), 'utf8')
  check('the mirror paints a WORKING session\'s life (glyph + activity) beside the title', mirrorSrc.includes("state === 'working'") && mirrorSrc.includes('<WorkingGlyph'))
}

console.log(
  failures === 0 ? '\nprove-w0-laws: ALL LAWS HOLD' : `\nprove-w0-laws: ${failures} FAILURE(S)`,
)
process.exit(failures === 0 ? 0 : 1)
