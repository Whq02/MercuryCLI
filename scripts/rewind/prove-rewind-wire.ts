#!/usr/bin/env bun
// ============================================================================
//  scripts/rewind/prove-rewind-wire.ts — THE RESTORE ROAD OVER THE WIRE
//  (release-hardening audit FN-015 rank 8, the restore half), cpu-pure.
//
//  THE FINDING: every restore the /rewind surface offered was refused
//  outright — no rewind verb existed on the daemon protocol, so the screen
//  could not ask the runner that owns a session to perform one.
//
//   §1 THE VERSION FACT: sessionRewind is appended to the op union, the
//      proto bumped (4 → 5) and the shape re-registered at the owner (the
//      protocol-shape prover runs green as a subprocess).
//   §2 THE ROUTE: the server routes the case, the client stamps the key,
//      the daemon wires the async dependency to the seat verb.
//   §3 THE SEAT VERB against a scripted roster and the REAL seat-line hook:
//      applied (the runner's receipt relayed verbatim) · refused typed for
//      an unknown session, a busy seat, no channel · the MIXED-VERSION LAW
//      (an older runner's unsupported-subtype error answers 'runner-older',
//      any other error 'restore-failed' with the runner's own sentence, a
//      silent runner the deadline's 'no-answer', a runner that ends
//      mid-wait the settle's 'no-answer') · a foreign settle never touches
//      a waiter.
//   §4 THE PROJECTION LAWS (checkpointRewind.ts): the operator's window is
//      [turn, record] inclusive in every provider-bound view AND the
//      cockpit's display; an agent's exploration window is unchanged
//      (exclusive, record kept, scrollback kept); identity when nothing
//      applies; a record whose turn left the view stands alone.
//   §5 THE CHILD-SIDE CONTROL SHAPE: rewind_session parses; a foreign mode
//      refuses at the schema.
//   §6 THE RUNNER HANDLER (pure, a fixture context): every typed refusal
//      arm (turn-active · not-found · before-compaction · capture-off ·
//      no-checkpoint) and the conversation rewind's record — appended to
//      the live conversation AND persisted to the transcript (identity
//      preserved: same session id, same file), dry run writes nothing.
//
//  Run: ~/.bun/bin/bun run scripts/rewind/prove-rewind-wire.ts
// ============================================================================
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dir, '..', '..')
const HOME = mkdtempSync(join(tmpdir(), 'rewind-wire-home-'))
const DAEMON_DIR = mkdtempSync(join(tmpdir(), 'rewind-wire-daemon-'))
mkdirSync(HOME, { recursive: true })
process.env.MERCURY_CONFIG_DIR = HOME
process.env.MERCURY_DAEMON_DIR = DAEMON_DIR
delete process.env.MERCURY_HOME
delete process.env.MERCURY_CONCOURSE_WORKER

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t)
}
const j = (v: unknown): string => JSON.stringify(v)
const read = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8')
const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))

// ── §1 the version fact ─────────────────────────────────────────────────────
section('§1 — the version fact: a new verb bumps the proto and re-registers the shape')
{
  const protocol = read('src/daemon/protocol.ts')
  const opsBlock = protocol.slice(protocol.indexOf('export type DaemonOp ='), protocol.indexOf('\n\n', protocol.indexOf('export type DaemonOp =')))
  const ops = Array.from(opsBlock.matchAll(/'([A-Za-z-]+)'/g), m => m[1]!)
  check('sessionRewind is the LAST op of the union (appended, never reordered)', ops[ops.length - 1] === 'sessionRewind', ops.slice(-3).join(','))
  check('MERCURY_DAEMON_PROTO is at least 5 (v4 → v5 with the verb; later verbs bump it further)', Number(/export const MERCURY_DAEMON_PROTO = (\d+)/.exec(protocol)?.[1] ?? 0) >= 5)
  check('the v5 line documents the verb beside the constant', protocol.includes(' *   v5  sessionRewind'))
  const shape = spawnSync(process.execPath, ['run', join(ROOT, 'scripts/daemon/prove-protocol-shape.ts')], { cwd: ROOT, encoding: 'utf8' })
  check('the protocol-shape prover accepts the re-registered hash (rc=0, all pass)', shape.status === 0 && shape.stdout.includes('ALL PROTOCOL-SHAPE PROOFS PASS'), `rc=${shape.status} ${shape.stdout.split('\n').filter(l => l.includes('FAIL')).join(' | ')}`)
  check('the request member names the point, the mode and the dry run', protocol.includes("op: 'sessionRewind'") && protocol.includes('userMessageId: string') && protocol.includes('mode: SessionRewindMode') && protocol.includes('dryRun?: boolean'))
  check('the reply member relays the runner\'s receipt (SessionRewindOutcomeV1)', protocol.includes("({ ok: true; op: 'sessionRewind' } & SessionRewindOutcomeV1)"))
  const kinds = protocol.slice(protocol.indexOf('export type RewindRefusalKind ='), protocol.indexOf('\n\n', protocol.indexOf('export type RewindRefusalKind =')))
  for (const kind of ['turn-active', 'not-found', 'capture-off', 'no-checkpoint', 'drift', 'backup-missing', 'before-compaction', 'restore-failed', 'runner-older', 'daemon-older', 'unknown-session', 'no-channel', 'no-answer', 'no-chat']) {
    check(`the refusal vocabulary names '${kind}'`, kinds.includes(`'${kind}'`))
  }
}

// ── §2 the route ────────────────────────────────────────────────────────────
section('§2 — the route: server case · client stamp · daemon dependency')
{
  const server = read('src/daemon/controlServer.ts')
  const socket = read('src/daemon/controlSocket.ts')
  const main = read('src/daemon/main.ts')
  check("the server routes case 'sessionRewind' and AWAITS the async dependency", server.includes("case 'sessionRewind': {") && server.includes('await deps.sessionRewind('))
  check('the server answers ENOTSUP when the host lacks the dependency (a non-concourse daemon)', server.slice(server.indexOf("case 'sessionRewind': {")).includes("code: 'ENOTSUP'"))
  check('the server narrows the mode and refuses a malformed ask typed', server.includes("raw.mode === 'code' || raw.mode === 'conversation' || raw.mode === 'both'") && server.includes('sessionRewind requires { sessionId, by, mode: code|conversation|both, userMessageId }'))
  check("the client stamps the control key on 'sessionRewind'", /const AUTH_STAMPED_OPS[^]*?'sessionRewind'[^]*?\]\)/.test(socket))
  check('the daemon wires the dependency to the seat verb', main.includes('sessionRewind: async req =>') && main.includes('return rewindSession(req.sessionId'))
}

// ── §3 the seat verb ────────────────────────────────────────────────────────
section('§3 — the seat verb: applied · typed refusals · the mixed-version law')
{
  const { updateConcourseWorkers } = await import('../../src/daemon/concourseSupervisor.ts')
  const seat = await import('../../src/daemon/sessionSeat.ts')
  const SESSION = 'rewind-wire-session-0001'
  const SHORT = 'concourse-w1'
  updateConcourseWorkers(workers => {
    for (const key of Object.keys(workers)) delete workers[key]
    workers[SHORT] = {
      schema: 1,
      runnerId: SHORT,
      sessionId: SESSION,
      workspaceId: '/scratch/repo',
      isolation: 'shared',
      modelKey: 'claude-opus-5',
      effort: 'high',
      spawnedAt: Date.now(),
      lastLiveAt: Date.now(),
    } as never
  }, DAEMON_DIR)

  type Frame = { type?: string; request_id?: string; request?: { subtype?: string; user_message_id?: string; mode?: string; dry_run?: boolean } }
  class FakeRoster {
    frames: Array<{ short: string; frame: Frame }> = []
    busy = false
    deliver = true
    answer: 'success' | 'error-older' | 'error-other' | 'never' = 'success'
    control(short: string, frame: string): boolean {
      const parsed = JSON.parse(frame) as Frame
      this.frames.push({ short, frame: parsed })
      if (!this.deliver) return false
      if (parsed.request?.subtype !== 'rewind_session' || this.answer === 'never') return true
      const requestId = parsed.request_id!
      const line =
        this.answer === 'success'
          ? j({ type: 'control_response', response: { subtype: 'success', request_id: requestId, response: { outcome: 'applied', mode: parsed.request.mode, code: { filesChanged: ['note.txt'], insertions: 1, deletions: 1 } } } })
          : j({ type: 'control_response', response: { subtype: 'error', request_id: requestId, error: this.answer === 'error-older' ? 'unsupported control request subtype: rewind_session' : 'the restore threw before any file was written: EACCES' } })
      // The answer rides the REAL seat-line hook, off the stack like a drain.
      queueMicrotask(() => seat.onSeatLine(short, line, this as never, DAEMON_DIR))
      return true
    }
    list(): Array<{ short: string; outcome?: string; busy?: boolean }> {
      return [{ short: SHORT, busy: this.busy }]
    }
    patchSeatModel(): boolean {
      return true
    }
    patchSeatEffort(): boolean {
      return true
    }
  }
  const rewindFrames = (r: FakeRoster) => r.frames.filter(f => f.frame.request?.subtype === 'rewind_session')

  // A — unknown session: no frame leaves the daemon.
  {
    const r = new FakeRoster()
    const out = await seat.rewindSession('no-such-session', { mode: 'code', userMessageId: 'u1' }, r as never, DAEMON_DIR)
    check('A unknown session refuses typed (unknown-session) and sends nothing', out.outcome === 'refused' && out.refusal === 'unknown-session' && rewindFrames(r).length === 0, j(out))
  }
  // B — busy seat: the conversation a turn is reading is never rewritten.
  {
    const r = new FakeRoster()
    r.busy = true
    const out = await seat.rewindSession(SESSION, { mode: 'both', userMessageId: 'u1' }, r as never, DAEMON_DIR)
    check('B a mid-turn seat refuses typed (turn-active) and sends nothing', out.outcome === 'refused' && out.refusal === 'turn-active' && rewindFrames(r).length === 0, j(out))
  }
  // C — applied: the runner's receipt relayed verbatim; the frame shape.
  {
    const r = new FakeRoster()
    const out = await seat.rewindSession(SESSION, { mode: 'code', userMessageId: 'u-42' }, r as never, DAEMON_DIR)
    const f = rewindFrames(r)[0]?.frame
    check('C the control frame is a rewind_session request naming the point and the mode', f?.type === 'control_request' && f.request?.user_message_id === 'u-42' && f.request.mode === 'code' && f.request.dry_run === undefined, j(f))
    check("C the request id rides the seat-verb prefix with the rewind marker", typeof f?.request_id === 'string' && f.request_id.startsWith('mercury-seat-rewind-'), String(f?.request_id))
    check("C the runner's receipt is relayed verbatim (applied, the files named)", out.outcome === 'applied' && out.mode === 'code' && out.code?.filesChanged[0] === 'note.txt' && out.code.insertions === 1, j(out))
    check('C no waiter lingers after the settle', seat._pendingRewindWaitersForTesting() === 0)
    check('C the settle re-asks the facts (the seat-verb arm still runs)', r.frames.some(x => x.frame.request?.subtype === 'session_facts'))
  }
  // C2 — a dry run stamps dry_run on the wire.
  {
    const r = new FakeRoster()
    await seat.rewindSession(SESSION, { mode: 'conversation', userMessageId: 'u-43', dryRun: true }, r as never, DAEMON_DIR)
    check('C2 a dry run stamps dry_run:true on the frame', rewindFrames(r)[0]?.frame.request?.dry_run === true)
  }
  // D — the mixed-version law: an OLDER runner answers the unsupported-subtype error.
  {
    const r = new FakeRoster()
    r.answer = 'error-older'
    const out = await seat.rewindSession(SESSION, { mode: 'both', userMessageId: 'u1' }, r as never, DAEMON_DIR)
    check("D an older runner's unsupported-subtype error answers 'runner-older', typed, naming the remedy", out.outcome === 'refused' && out.refusal === 'runner-older' && (out.detail ?? '').includes('/daemon restart') && out.mode === 'both', j(out))
  }
  // E — any other error frame: 'restore-failed' with the runner's own sentence.
  {
    const r = new FakeRoster()
    r.answer = 'error-other'
    const out = await seat.rewindSession(SESSION, { mode: 'code', userMessageId: 'u1' }, r as never, DAEMON_DIR)
    check("E a thrown restore answers 'restore-failed' carrying the runner's sentence", out.outcome === 'refused' && out.refusal === 'restore-failed' && (out.detail ?? '').includes('EACCES'), j(out))
  }
  // F — a silent runner: the deadline answers 'no-answer'.
  {
    const r = new FakeRoster()
    r.answer = 'never'
    const t0 = Date.now()
    const out = await seat.rewindSession(SESSION, { mode: 'code', userMessageId: 'u1' }, r as never, DAEMON_DIR, { deadlineMs: 120 })
    check("F a runner silent past the deadline answers 'no-answer' (nothing assumed restored)", out.outcome === 'refused' && out.refusal === 'no-answer' && (out.detail ?? '').includes('nothing is assumed restored') && Date.now() - t0 >= 100, j(out))
    check('F the deadline clears its waiter', seat._pendingRewindWaitersForTesting() === 0)
  }
  // G — no channel: control() refuses delivery.
  {
    const r = new FakeRoster()
    r.deliver = false
    const out = await seat.rewindSession(SESSION, { mode: 'code', userMessageId: 'u1' }, r as never, DAEMON_DIR)
    check("G an undeliverable frame answers 'no-channel' with no waiter left", out.outcome === 'refused' && out.refusal === 'no-channel' && seat._pendingRewindWaitersForTesting() === 0, j(out))
  }
  // H — the runner ends mid-wait: the settle answers every pending rewind typed.
  {
    const r = new FakeRoster()
    r.answer = 'never'
    const pending = seat.rewindSession(SESSION, { mode: 'conversation', userMessageId: 'u1' }, r as never, DAEMON_DIR, { deadlineMs: 5_000 })
    await sleep(10)
    check('H the ask is pending', seat._pendingRewindWaitersForTesting() === 1)
    seat.onSeatSettled(SHORT)
    const out = await pending
    check("H a runner that ends mid-wait answers 'no-answer' naming the end", out.outcome === 'refused' && out.refusal === 'no-answer' && (out.detail ?? '').includes('ended'), j(out))
  }
  // I — a foreign settle (a set-model control_response) never touches a waiter.
  {
    const r = new FakeRoster()
    r.answer = 'never'
    const pending = seat.rewindSession(SESSION, { mode: 'code', userMessageId: 'u1' }, r as never, DAEMON_DIR, { deadlineMs: 200 })
    await sleep(5)
    seat.onSeatLine(SHORT, j({ type: 'control_response', response: { subtype: 'success', request_id: 'mercury-seat-set-model-concourse-w1-zz' } }), r as never, DAEMON_DIR)
    check('I a foreign verb settle leaves the rewind waiter pending', seat._pendingRewindWaitersForTesting() === 1)
    const out = await pending
    check('I …and the deadline still answers it typed', out.refusal === 'no-answer')
  }
}

// ── §4 the projection laws ──────────────────────────────────────────────────
section('§4 — the projection laws: the operator window is inclusive in every view')
{
  const cr = await import('../../src/services/compact/checkpointRewind.ts')
  const { createUserMessage, createAssistantMessage } = await import('../../src/utils/messages/factories.ts')
  const u = (text: string) => createUserMessage({ content: text })
  const a = (text: string) => createAssistantMessage({ content: text } as never)
  const turn1 = u('first task')
  const reply1 = a('done one')
  const turn2 = u('second task')
  const reply2 = a('done two')
  const record = cr.createOperatorRewindRecordMessage({ turnUuid: turn2.uuid, removed: 2 })
  const turn3 = u('third task (after the rewind)')
  const messages = [turn1, reply1, turn2, reply2, record, turn3]

  check('the operator record is hidden (isMeta) and keyed by the turn', (record as { isMeta?: boolean }).isMeta === true && typeof record.message.content === 'string' && record.message.content.startsWith('<mercury-rewind-record turn="') && record.message.content.includes(`turn="${turn2.uuid}"`) && record.message.content.includes('by="operator"'))
  const provider = cr.projectRewoundWindows(messages)
  check('the provider view excludes [turn, record] INCLUSIVE — the classic truncation', provider.length === 3 && provider[0] === turn1 && provider[1] === reply1 && provider[2] === turn3, j(provider.map(m => m.uuid.slice(0, 4))))
  const display = cr.projectOperatorRewinds(messages)
  check('the display view excludes the same window (the chat paints the boundary)', display.length === 3 && display[2] === turn3)
  check('nothing to apply ⇒ identity (render layers bail on identity)', cr.projectRewoundWindows([turn1, reply1]) === ([turn1, reply1] as unknown) || cr.projectOperatorRewinds([turn1, reply1]).length === 2)
  const plain = [turn1, reply1]
  check('projectOperatorRewinds returns the SAME array when no operator record exists', cr.projectOperatorRewinds(plain) === plain)
  // A record whose turn left the view (compacted away): only the record leaves.
  const orphan = [reply2, record, turn3]
  const orphanView = cr.projectRewoundWindows(orphan)
  check('a record whose turn left the view stands alone — only the record is excluded', orphanView.length === 2 && orphanView[0] === reply2 && orphanView[1] === turn3)
  // The AGENT's window is unchanged: exclusive, the record stays, the display keeps scrollback.
  const cpUse = createAssistantMessage({ content: [{ type: 'tool_use', id: 'toolu_cp1', name: 'Checkpoint', input: { goal: 'try' } }] } as never)
  const cpResult = createUserMessage({ content: [{ type: 'tool_result', tool_use_id: 'toolu_cp1', content: 'checkpoint set' }] })
  const explore = a('exploring…')
  const agentRecord = cr.createRewindRecordMessage({ checkpointId: 'toolu_cp1', goal: 'try', report: 'nothing found', abandonedMessageCount: 1, rootFallback: false })
  const agentMessages = [turn1, cpUse, cpResult, explore, agentRecord]
  const agentProvider = cr.projectRewoundWindows(agentMessages)
  check("the agent's window is EXCLUSIVE and its record stays in the provider view (unchanged law)", agentProvider.length === 4 && !agentProvider.includes(explore) && agentProvider.includes(agentRecord))
  check("the display keeps the agent's exploration (scrollback law) — projectOperatorRewinds is identity there", cr.projectOperatorRewinds(agentMessages) === agentMessages)
  // Nested: an operator rewind AFTER an agent rewind; both windows fold.
  const both = [...agentMessages, turn2, reply2, record, turn3]
  const bothView = cr.projectRewoundWindows(both)
  check('both kinds of window fold into one provider view', !bothView.includes(explore) && !bothView.includes(turn2) && !bothView.includes(reply2) && !bothView.includes(record) && bothView.includes(turn3) && bothView.includes(agentRecord))
}

// ── §5 the child-side control shape ─────────────────────────────────────────
section('§5 — the child-side control: rewind_session parses; a foreign mode refuses at the schema')
{
  const { SDKControlRequestSchema } = await import('../../src/entrypoints/sdk/controlSchemas.ts')
  const ok = SDKControlRequestSchema().safeParse({ type: 'control_request', request_id: 'r1', request: { subtype: 'rewind_session', user_message_id: 'u1', mode: 'both', dry_run: true } })
  check('a well-formed rewind_session control parses', ok.success, ok.success ? '' : j(ok.error.issues).slice(0, 200))
  const bad = SDKControlRequestSchema().safeParse({ type: 'control_request', request_id: 'r2', request: { subtype: 'rewind_session', user_message_id: 'u1', mode: 'files' } })
  check("a foreign mode ('files') refuses at the schema", !bad.success)
  const types = read('src/entrypoints/sdk/controlTypes.ts')
  check('the control union names SDKControlRewindSessionRequest', types.includes('| SDKControlRewindSessionRequest'))
}

// ── §6 the runner handler ───────────────────────────────────────────────────
section('§6 — the runner handler: every typed refusal arm, and the conversation record persisted')
{
  const { enableConfigs } = await import('../../src/utils/config/globalConfig.ts')
  enableConfigs()
  const state = await import('../../src/bootstrap/state.ts')
  const { handleRewindSession } = await import('../../src/cli/headless/controlHandlers.ts')
  const { createUserMessage, createAssistantMessage } = await import('../../src/utils/messages/factories.ts')
  const { createCompactBoundaryMessage } = await import('../../src/utils/messages/systemMessages.ts')
  const { getDefaultAppState } = await import('../../src/state/AppStateStore.ts')
  const { getTranscriptPathForSession } = await import('../../src/utils/sessionStorage/paths.ts')
  const u = (text: string) => createUserMessage({ content: text })
  const a = (text: string) => createAssistantMessage({ content: text } as never)
  const noDrift = { get: () => undefined }
  const appState = getDefaultAppState()
  const ctx = (messages: unknown[], turnActive = false) => ({ messages: messages as never, getAppState: () => appState, drift: noDrift, turnActive })

  state.setIsInteractive(false)
  delete process.env.MERCURY_CONCOURSE_WORKER
  const t1 = u('first')
  const r1 = a('one')
  const t2 = u('second')
  const r2 = a('two')

  const busy = await handleRewindSession({ subtype: 'rewind_session', user_message_id: t2.uuid, mode: 'conversation' }, ctx([t1, r1, t2, r2], true))
  check("turn-active: a running turn refuses typed before anything else", busy.outcome === 'refused' && busy.refusal === 'turn-active', j(busy))
  const missing = await handleRewindSession({ subtype: 'rewind_session', user_message_id: 'no-such-uuid', mode: 'code' }, ctx([t1, r1, t2, r2]))
  check("not-found: an unknown point refuses typed", missing.outcome === 'refused' && missing.refusal === 'not-found', j(missing))
  const boundary = createCompactBoundaryMessage('manual', 100)
  const folded = await handleRewindSession({ subtype: 'rewind_session', user_message_id: t1.uuid, mode: 'both' }, ctx([t1, r1, boundary, t2, r2]))
  check("before-compaction: a point before the last fold refuses typed BEFORE any file is touched ('both' included)", folded.outcome === 'refused' && folded.refusal === 'before-compaction', j(folded))
  const off = await handleRewindSession({ subtype: 'rewind_session', user_message_id: t2.uuid, mode: 'code' }, ctx([t1, r1, t2, r2]))
  check("capture-off: a plain -p process (no worker stamp) refuses the code half typed, naming Settings", off.outcome === 'refused' && off.refusal === 'capture-off' && (off.detail ?? '').includes('Settings'), j(off))
  process.env.MERCURY_CONCOURSE_WORKER = '1'
  const none = await handleRewindSession({ subtype: 'rewind_session', user_message_id: t2.uuid, mode: 'code' }, ctx([t1, r1, t2, r2]))
  check("no-checkpoint: a point with no saved files refuses typed", none.outcome === 'refused' && none.refusal === 'no-checkpoint', j(none))

  // The conversation rewind: dry run writes nothing; the apply appends the
  // record to the live conversation AND the transcript of THIS session.
  const sid = state.getSessionId()
  const transcript = getTranscriptPathForSession(String(sid))
  const live = [t1, r1, t2, r2]
  const dry = await handleRewindSession({ subtype: 'rewind_session', user_message_id: t2.uuid, mode: 'conversation', dry_run: true }, ctx(live))
  check('a conversation dry run reports the boundary and the count, appends nothing', dry.outcome === 'applied' && dry.dryRun === true && dry.conversation?.turnUuid === t2.uuid && dry.conversation.removed === 2 && live.length === 4, j(dry))
  const applied = await handleRewindSession({ subtype: 'rewind_session', user_message_id: t2.uuid, mode: 'conversation' }, ctx(live))
  check('the conversation rewind answers applied with the boundary', applied.outcome === 'applied' && applied.conversation?.turnUuid === t2.uuid && applied.conversation.removed === 2, j(applied))
  const last = live[live.length - 1] as { isMeta?: boolean; message?: { content?: unknown } }
  check('the operator record was appended to the live conversation (isMeta, keyed by the turn)', live.length === 5 && last.isMeta === true && String(last.message?.content).includes(`turn="${t2.uuid}"`))
  check('the record persisted to THIS session\'s transcript (identity preserved — same id, same file)', existsSync(transcript) && readFileSync(transcript, 'utf8').includes(`turn=\\"${t2.uuid}\\"`), `path=${transcript} exists=${existsSync(transcript)}`)
  const { projectRewoundWindows } = await import('../../src/services/compact/checkpointRewind.ts')
  const next = projectRewoundWindows(live as never)
  check("the next provider-bound view is the classic truncation (first turn only)", next.length === 2 && (next[0] as { uuid: string }).uuid === t1.uuid)
  delete process.env.MERCURY_CONCOURSE_WORKER
}

console.log('\n' + '═'.repeat(76))
if (failures === 0) console.log('✅ ALL REWIND WIRE PROOFS PASS')
else console.log(`❌ ${failures} REWIND WIRE PROOF(S) FAILED`)
console.log('═'.repeat(76))
process.exit(failures === 0 ? 0 : 1)
