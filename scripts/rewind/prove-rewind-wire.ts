#!/usr/bin/env bun
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
const wireWheres: Record<string, string> = {
  '§3': 'fix rewindSession in src/daemon/session-seat/sessionSeat.ts (the typed refusals and the request it sends)',
  '§4': 'fix projectRewoundWindows and projectOperatorRewinds in src/engine/compaction/checkpointRewind.ts',
  '§5': 'fix the session/rewind params in METHODS in src/daemon/runner-wire/methods.ts',
  '§6': 'fix handleRewindSession in src/daemon/runner/controlHandlers.ts (the typed refusal arms and the conversation record)',
}
let wireWhere = ''
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond ? ` — ${detail ? `${detail} | ` : ''}${wireWhere}` : ''}`)
}
function section(t: string): void {
  wireWhere = wireWheres[t.slice(0, 2)] ?? ''
  console.log('\n' + '─'.repeat(76) + '\n' + t)
}
const j = (v: unknown): string => JSON.stringify(v)
const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))

section('§3 — the seat verb: applied · typed refusals · the mixed-version law')
{
  const { updateConcourseWorkers } = await import('../../src/daemon/concourse-workers/concourseWorkers.ts')
  const seat = await import('../../src/daemon/session-seat/sessionSeat.ts')
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

  const { standInRunner } = await import('../lib/seatDoor.ts')
  const { RPC_METHOD_NOT_FOUND, RPC_REFUSED } = await import('../../src/daemon/runner-wire/errors.ts')
  type Stand = ReturnType<typeof standInRunner>
  const runnerOf = (answer: 'success' | 'error-older' | 'error-other' | 'never', busy = false): { stand: Stand; roster: ReturnType<Stand['roster']> } => {
    const stand = standInRunner({ autoAnswer: { 'session/facts': {} } })
    void (async () => {
      for (;;) {
        const request = await stand.nextRequest('session/rewind', 600_000).catch(() => null)
        if (request === null) return
        if (answer === 'never') continue
        const params = request.params as { mode: string }
        if (answer === 'success') request.answer({ outcome: 'applied', mode: params.mode, code: { filesChanged: ['note.txt'], insertions: 1, deletions: 1 } })
        else if (answer === 'error-older') request.refuse(RPC_METHOD_NOT_FOUND, 'unknown method session/rewind', { method: 'session/rewind' })
        else request.refuse(RPC_REFUSED, 'the restore threw before any file was written: EACCES', { kind: 'rewind' })
      }
    })()
    return { stand, roster: stand.roster({ list: () => [{ short: SHORT, busy }] }) }
  }
  const rewinds = (stand: Stand) => stand.requests.filter(r => r.method === 'session/rewind')

  {
    const { stand, roster } = runnerOf('success')
    const out = await seat.rewindSession('no-such-session', { mode: 'code', userMessageId: 'u1' }, roster as never, DAEMON_DIR)
    check('A unknown session refuses typed (unknown-session) and sends nothing', out.outcome === 'refused' && out.refusal === 'unknown-session' && rewinds(stand).length === 0, j(out))
    stand.close()
  }
  {
    const { stand, roster } = runnerOf('success', true)
    const out = await seat.rewindSession(SESSION, { mode: 'both', userMessageId: 'u1' }, roster as never, DAEMON_DIR)
    check('B a mid-turn seat refuses typed (turn-active) and sends nothing', out.outcome === 'refused' && out.refusal === 'turn-active' && rewinds(stand).length === 0, j(out))
    stand.close()
  }
  {
    const { stand, roster } = runnerOf('success')
    const out = await seat.rewindSession(SESSION, { mode: 'code', userMessageId: 'u-42' }, roster as never, DAEMON_DIR)
    const f = rewinds(stand)[0]?.params as { user_message_id?: string; mode?: string; dry_run?: boolean } | undefined
    check('C the request is session/rewind naming the point and the mode', f?.user_message_id === 'u-42' && f.mode === 'code' && f.dry_run === undefined, j(f))
    check("C the runner's receipt is relayed verbatim (applied, the files named)", out.outcome === 'applied' && out.mode === 'code' && out.code?.filesChanged[0] === 'note.txt' && out.code.insertions === 1, j(out))
    await sleep(20)
    check('C nothing lingers pending after the settle', stand.connection.peer.pendingCount === 0, String(stand.connection.peer.pendingCount))
    check('C the settle re-asks the facts (the seat-verb law still runs)', stand.requests.some(x => x.method === 'session/facts'))
    stand.close()
  }
  {
    const { stand, roster } = runnerOf('success')
    await seat.rewindSession(SESSION, { mode: 'conversation', userMessageId: 'u-43', dryRun: true }, roster as never, DAEMON_DIR)
    check('C2 a dry run stamps dry_run:true on the request', (rewinds(stand)[0]?.params as { dry_run?: boolean } | undefined)?.dry_run === true)
    stand.close()
  }
  {
    const { stand, roster } = runnerOf('error-older')
    const out = await seat.rewindSession(SESSION, { mode: 'both', userMessageId: 'u1' }, roster as never, DAEMON_DIR)
    check("D an older runner's unknown method (-32601) answers 'runner-older', typed, naming the remedy", out.outcome === 'refused' && out.refusal === 'runner-older' && (out.detail ?? '').includes('/daemon restart') && out.mode === 'both', j(out))
    stand.close()
  }
  {
    const { stand, roster } = runnerOf('error-other')
    const out = await seat.rewindSession(SESSION, { mode: 'code', userMessageId: 'u1' }, roster as never, DAEMON_DIR)
    check("E a thrown restore answers 'restore-failed' carrying the runner's sentence", out.outcome === 'refused' && out.refusal === 'restore-failed' && (out.detail ?? '').includes('EACCES'), j(out))
    stand.close()
  }
  {
    const { stand, roster } = runnerOf('never')
    const t0 = Date.now()
    const out = await seat.rewindSession(SESSION, { mode: 'code', userMessageId: 'u1' }, roster as never, DAEMON_DIR, { deadlineMs: 120 })
    check("F a runner silent past the deadline answers 'no-answer' (nothing assumed restored)", out.outcome === 'refused' && out.refusal === 'no-answer' && (out.detail ?? '').includes('nothing is assumed restored') && Date.now() - t0 >= 100, j(out))
    await sleep(20)
    check('F the deadline clears the pending request and withdraws it from the runner', stand.connection.peer.pendingCount === 0 && rewinds(stand)[0]!.cancelled)
    stand.close()
  }
  {
    const { stand, roster } = runnerOf('success')
    const out = await seat.rewindSession(SESSION, { mode: 'code', userMessageId: 'u1' }, { ...roster, door: () => undefined } as never, DAEMON_DIR)
    check("G a seat with no door answers 'no-channel' and sends nothing", out.outcome === 'refused' && out.refusal === 'no-channel' && rewinds(stand).length === 0, j(out))
    stand.close()
  }
  {
    const { stand, roster } = runnerOf('never')
    const pending = seat.rewindSession(SESSION, { mode: 'conversation', userMessageId: 'u1' }, roster as never, DAEMON_DIR, { deadlineMs: 5_000 })
    await sleep(10)
    check('H the ask is pending', stand.connection.peer.pendingCount === 1)
    stand.connection.close('the runner exited')
    const out = await pending
    check("H a runner that leaves mid-wait answers 'no-answer' naming the departure", out.outcome === 'refused' && out.refusal === 'no-answer' && (out.detail ?? '').includes('left before it answered'), j(out))
    stand.close()
  }
  {
    const { stand, roster } = runnerOf('never')
    const pending = seat.rewindSession(SESSION, { mode: 'code', userMessageId: 'u1' }, roster as never, DAEMON_DIR, { deadlineMs: 200 })
    await sleep(5)
    stand.rawToHost(JSON.stringify({ jsonrpc: '2.0', id: 999, result: { outcome: 'applied', mode: 'code' } }) + '\n')
    await sleep(5)
    check('I an answer for an id that is not pending leaves the rewind pending', stand.connection.peer.pendingCount === 1)
    const out = await pending
    check('I …and the deadline still answers it typed', out.refusal === 'no-answer')
    stand.close()
  }
}

section('§4 — the projection laws: the operator window is inclusive in every view')
{
  const cr = await import('../../src/engine/compaction/checkpointRewind.ts')
  const { createUserMessage, createAssistantMessage } = await import('../../src/engine/message-shapes/factories.ts')
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
  const plain = [turn1, reply1]
  check('nothing to apply ⇒ identity (render layers bail on identity): the provider projection returns the SAME array', cr.projectRewoundWindows(plain) === plain)
  check('projectOperatorRewinds returns the SAME array when no operator record exists', cr.projectOperatorRewinds(plain) === plain)
  check('a window to apply ⇒ a NEW array from both projections (identity is never faked on a real cut)', cr.projectRewoundWindows(messages) !== messages && cr.projectOperatorRewinds(messages) !== messages)
  const orphan = [reply2, record, turn3]
  const orphanView = cr.projectRewoundWindows(orphan)
  check('a record whose turn left the view stands alone — only the record is excluded', orphanView.length === 2 && orphanView[0] === reply2 && orphanView[1] === turn3)
  const cpUse = createAssistantMessage({ content: [{ type: 'tool_use', id: 'toolu_cp1', name: 'Checkpoint', input: { goal: 'try' } }] } as never)
  const cpResult = createUserMessage({ content: [{ type: 'tool_result', tool_use_id: 'toolu_cp1', content: 'checkpoint set' }] })
  const explore = a('exploring…')
  const agentRecord = cr.createRewindRecordMessage({ checkpointId: 'toolu_cp1', goal: 'try', report: 'nothing found', abandonedMessageCount: 1, rootFallback: false })
  const agentMessages = [turn1, cpUse, cpResult, explore, agentRecord]
  const agentProvider = cr.projectRewoundWindows(agentMessages)
  check("the agent's window is EXCLUSIVE and its record stays in the provider view (unchanged law)", agentProvider.length === 4 && !agentProvider.includes(explore) && agentProvider.includes(agentRecord))
  check("the display keeps the agent's exploration (scrollback law) — projectOperatorRewinds is identity there", cr.projectOperatorRewinds(agentMessages) === agentMessages)
  const both = [...agentMessages, turn2, reply2, record, turn3]
  const bothView = cr.projectRewoundWindows(both)
  check('both kinds of window fold into one provider view', !bothView.includes(explore) && !bothView.includes(turn2) && !bothView.includes(reply2) && !bothView.includes(record) && bothView.includes(turn3) && bothView.includes(agentRecord))
}

section('§5 — the runner door: session/rewind parses; a foreign mode refuses at the schema')
{
  const { METHODS } = await import('../../src/daemon/runner-wire/methods.ts')
  const params = METHODS['session/rewind'].params()
  const ok = params.safeParse({ user_message_id: 'u1', mode: 'both', dry_run: true })
  check('a well-formed session/rewind request parses', ok.success, ok.success ? '' : j(ok.error.issues).slice(0, 200))
  const bad = params.safeParse({ user_message_id: 'u1', mode: 'files' })
  check("a foreign mode ('files') refuses at the schema", !bad.success)
}

section('§6 — the runner handler: every typed refusal arm, and the conversation record persisted')
{
  const { enableConfigs } = await import('../../src/platform/config/globalConfig.ts')
  enableConfigs()
  const state = await import('../../src/boot/process-state/processState.ts')
  const { handleRewindSession } = await import('../../src/daemon/runner/controlHandlers.ts')
  const { createUserMessage, createAssistantMessage } = await import('../../src/engine/message-shapes/factories.ts')
  const { createFoldBoundaryMessage } = await import('../../src/engine/message-shapes/systemMessages.ts')
  const { getDefaultAppState } = await import('../../src/screen/app-state/AppStateStore.ts')
  const { getTranscriptPathForSession } = await import('../../src/sessions/transcripts/paths.ts')
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
  const boundary = createFoldBoundaryMessage('manual', 100)
  const folded = await handleRewindSession({ subtype: 'rewind_session', user_message_id: t1.uuid, mode: 'both' }, ctx([t1, r1, boundary, t2, r2]))
  check("before-compaction: a point before the last fold refuses typed BEFORE any file is touched ('both' included)", folded.outcome === 'refused' && folded.refusal === 'before-compaction', j(folded))
  const off = await handleRewindSession({ subtype: 'rewind_session', user_message_id: t2.uuid, mode: 'code' }, ctx([t1, r1, t2, r2]))
  check("capture-off: a plain run process (no worker stamp, no initialize ask) refuses the code half typed, naming the initialize option as its road", off.outcome === 'refused' && off.refusal === 'capture-off' && (off.detail ?? '').includes('file_checkpoints on initialize'), j(off))
  process.env.MERCURY_CONCOURSE_WORKER = '1'
  const none = await handleRewindSession({ subtype: 'rewind_session', user_message_id: t2.uuid, mode: 'code' }, ctx([t1, r1, t2, r2]))
  check("no-checkpoint: a point with no saved files refuses typed", none.outcome === 'refused' && none.refusal === 'no-checkpoint', j(none))

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
  const { projectRewoundWindows } = await import('../../src/engine/compaction/checkpointRewind.ts')
  const next = projectRewoundWindows(live as never)
  check("the next provider-bound view is the classic truncation (first turn only)", next.length === 2 && (next[0] as { uuid: string }).uuid === t1.uuid)

  const { rmSync } = await import('node:fs')
  const dbg = await import('../../src/platform/logs/debugLog.ts')
  const prevNodeEnv = process.env.NODE_ENV
  delete process.env.NODE_ENV
  dbg.enableDebugLogging()
  const dbgPath = dbg.getDebugLogPath()
  rmSync(transcript, { recursive: true, force: true })
  mkdirSync(transcript, { recursive: true })
  try {
    const failed = await handleRewindSession({ subtype: 'rewind_session', user_message_id: t2.uuid, mode: 'conversation' }, ctx([t1, r1, t2, r2]))
    await dbg.flushDebugLogs()
    const dbgText = (() => { try { return readFileSync(dbgPath, 'utf8') } catch { return '' } })()
    check(
      'a failed transcript write refuses with the plain sentence and logs detail to debug log',
      failed.outcome === 'refused' &&
        failed.refusal === 'restore-failed' &&
        failed.detail === 'the conversation boundary could not be written to the transcript — try again' &&
        dbgText.includes('EISDIR'),
      `${j(failed)} | dbg=${dbgText.slice(-250)}`,
    )
  } finally {
    if (prevNodeEnv !== undefined) process.env.NODE_ENV = prevNodeEnv
    rmSync(transcript, { recursive: true, force: true })
  }
  delete process.env.MERCURY_CONCOURSE_WORKER
}

console.log('\n' + '═'.repeat(76))
if (failures === 0) console.log('✅ ALL REWIND WIRE PROOFS PASS')
else console.log(`❌ ${failures} REWIND WIRE PROOF(S) FAILED`)
console.log('═'.repeat(76))
process.exit(failures === 0 ? 0 : 1)
