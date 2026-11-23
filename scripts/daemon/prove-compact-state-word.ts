#!/usr/bin/env bun
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'stateword-home-'))

const { onSeatRow, onSeatSpawned } = await import('../../src/daemon/session-seat/sessionSeat.ts')
const { readSessionTail } = await import('../../src/engine/connector/seatProjections.ts')
const { updateConcourseWorkers } = await import('../../src/daemon/concourse-workers/concourseWorkers.ts')

let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}

const dir = mkdtempSync(join(tmpdir(), 'stateword-daemon-'))
const sid = 'aaaaaaaa-bbbb-4ccc-8ddd-stateword001'
const SHORT = 'concourse-sw1'
updateConcourseWorkers(workers => {
  workers[SHORT] = {
    schema: 1,
    runnerId: SHORT,
    sessionId: sid,
    workspaceId: 'ws-sw',
    isolation: 'exclusive',
    modelKey: 'claude-opus-5',
    effort: 'high',
    spawnedAt: Date.now(),
    lastLiveAt: Date.now(),
    settingsSnapshot: { schema: 1, snapshotId: 's', sessionId: sid, profileRevision: 0, profileDigest: 'd', resolvedAt: Date.now(), rows: [] } as never,
    workspaceKind: 'plain-folder',
  } as never
}, dir)
const roster = { door: () => undefined, list: () => [], patchSeatModel: () => true, patchSeatEffort: () => true }

const { compactionClearedRow, compactionRow } = await import('../../src/engine/rows/project.ts')
const scope = { session_id: sid, turn: 1 }
const row = (o: Record<string, unknown>): Record<string, unknown> => ({ seq: 1, timestamp: 't', ...o })
const foldRow = (fold: unknown): Record<string, unknown> => row(compactionRow(scope, fold as never))
const clearedRow = (): Record<string, unknown> => row(compactionClearedRow(scope, 'auto'))
const USAGE = { input_tokens: 1, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 1 }
const outcome = (): Record<string, unknown> => row({ type: 'outcome', session_id: sid, turn: 1, schema: 1, turn_id: 't-cw', status: 'completed', steps: 1, wall_ms: 1, usage: USAGE, models: [], denials: [] })
const tail = () => readSessionTail(sid, dir)
const word = () => (tail() as { stateWord?: string } | null)?.stateWord
const ROWS_AT = 'onSeatRow in src/daemon/session-seat/rows.ts (the compaction and outcome cases)'
const STATUS_AT = 'withFoldStatus in src/engine/compaction/fold/foldStatusAndRestore.ts'

console.log('compact state word — the fold speaks its own word on the glass road')

console.log('\nC1 the compaction row sets the word')
onSeatRow(SHORT, foldRow(null), roster as never, dir)
check("a started compaction row ⇒ the tail projection carries the word", word() === 'compacting', JSON.stringify(tail()) + ' — change ' + ROWS_AT + ' to set seat.stateWord to compacting on a started compaction row')

console.log('\nC2 the ended row clears it (the restore)')
onSeatRow(SHORT, clearedRow(), roster as never, dir)
check('the ended row ⇒ the word is gone', word() === undefined, JSON.stringify(tail()) + ' — change ' + ROWS_AT + ' to clear seat.stateWord on a cleared compaction row')

console.log('\nC3 the outcome row clears it (the settle belt)')
onSeatRow(SHORT, foldRow(null), roster as never, dir)
check('the word stands before the settle', word() === 'compacting', 'a started compaction row must set the word before an outcome arrives; see ' + ROWS_AT)
onSeatRow(SHORT, outcome(), roster as never, dir)
check('the outcome row retires the word with the turn', word() === undefined, JSON.stringify(tail()) + ' — change ' + ROWS_AT + ' so an outcome row clears seat.stateWord')

console.log('\nC4 a respawn clears it (a child dead mid-fold)')
onSeatRow(SHORT, foldRow(null), roster as never, dir)
onSeatSpawned(SHORT, roster as never, dir)
check('the respawn retires the word', word() === undefined, JSON.stringify(tail()) + ' — change onSeatSpawned in src/daemon/session-seat/lifecycle.ts to clear seat.stateWord')

console.log('\nC5 a mention-shaped line never sets it')
onSeatRow(SHORT, row({ type: 'text', session_id: sid, turn: 1, message_id: 'msg_c5', block: 0, text: 'the row spelling is {"type":"compaction","state":"started"} verbatim' }), roster as never, dir)
check('a text row CONTAINING the token leaves no word', word() === undefined, JSON.stringify(tail()) + ' — ' + ROWS_AT + ' must switch on the row type, never match the compaction spelling inside a text row')
onSeatRow(SHORT, outcome(), roster as never, dir)

console.log('\nC6 the wiring — service stamp to glass word (structural)')
{
  const { LivePart } = await import('../../src/engine/connector/daemon/live.ts')
  const { IDLE_LIVE } = await import('../../src/engine/connector/seatLive.ts')
  const fold = { runs: true }
  const lifted = new LivePart({ sessionId: () => 'proof', attached: () => false, factsBusy: () => true, work: () => [], factsTurnStartedAt: () => undefined, streamIdleTimeoutMs: () => undefined, model: () => 'the-model', anySendDelivered: () => false, redressQueuedSends: () => {}, transcriptLive: () => IDLE_LIVE, toolStartedAtMs: () => null, tailHeld: () => false, clearTail: () => {}, tailInterrupted: () => {}, tailInterruptUndone: () => {}, foldStillRuns: () => fold.runs, setLiveFold: () => {}, dropRunningFoldAtIdle: () => {}, stepTurnCompletion: () => false, syncFeedCadence: () => {}, probeCarrier: () => {} } as never)
  lifted.recomputeLive()
  const before = lifted.live().phase
  lifted.takeTail({ schema: 1, sessionId: 'proof', atMs: 1, text: null, stateWord: 'compacting' } as never)
  const during = lifted.live().phase
  fold.runs = false
  lifted.recomputeLive()
  const ended = lifted.live().phase
  fold.runs = true
  lifted.recomputeLive()
  lifted.takeTail({ schema: 1, sessionId: 'proof', atMs: 2, text: null } as never)
  check("the connector lifts the word into phase 'compacting'", before === 'thinking' && during === 'compacting' && ended === 'thinking' && lifted.live().phase === 'thinking', JSON.stringify({ before, during, ended, after: lifted.live().phase }) + ' — LivePart in src/engine/connector/daemon/live.ts (takeTail, recomputeLive) must show phase compacting only while the tail word is set and foldStillRuns() is true')
}

console.log('\nC7 the status covers the WHOLE fold — the entries stamp first, the one finally stamps the exit')
{
  const { withFoldStatus } = await import('../../src/engine/compaction/foldConversation.ts')
  const compactingOf = (stamp: unknown): { stage?: unknown; exit?: unknown; trigger?: unknown } | null =>
    stamp !== null && typeof stamp === 'object' && 'compacting' in (stamp as object) ? ((stamp as { compacting: { stage?: unknown; exit?: unknown; trigger?: unknown } }).compacting ?? null) : null
  const stamps: unknown[] = []
  const context = { setSDKStatus: (word: unknown) => stamps.push(word), abortController: new AbortController() } as never
  const seenAtWork: unknown[] = []
  const out = await withFoldStatus(context, async () => {
    seenAtWork.push(...stamps)
    return 'folded'
  }, { trigger: 'manual', sessionMemory: false, microcompaction: true })
  check("the stamp lands BEFORE the work runs (the session-memory wait and the prompt build sit inside it)", seenAtWork.length === 1 && compactingOf(seenAtWork[0])?.stage === null, STATUS_AT + ' must call setSDKStatus with a compacting record before it runs the work; saw ' + JSON.stringify(seenAtWork))
  check("the work's answer rides through", out === 'folded', STATUS_AT + ' must return the work function result unchanged; got ' + JSON.stringify(out))
  check('the one finally stamps the landed exit (one stamp in, one exit out)', stamps.length === 2 && compactingOf(stamps[1])?.exit === 'landed', STATUS_AT + ' must stamp exactly one landed exit after the work; stamps ' + JSON.stringify(stamps))
  const { APIUserAbortError } = await import('../../src/engine/request-parts/sdkErrors.ts')
  const thrown: unknown[] = []
  let caught: unknown = null
  try {
    await withFoldStatus({ setSDKStatus: (word: unknown) => thrown.push(word), abortController: new AbortController() } as never, async () => {
      throw new APIUserAbortError()
    }, { trigger: 'manual', sessionMemory: false, microcompaction: true })
  } catch (e) {
    caught = e
  }
  check('a cancelled fold still exits (a stamp never outlives the command) — cancelled, by its typed class', caught instanceof APIUserAbortError && thrown.length === 2 && compactingOf(thrown[1])?.exit === 'cancelled', STATUS_AT + ' must stamp exit cancelled for an APIUserAbortError and rethrow it; stamps ' + JSON.stringify(thrown))
  const failed: unknown[] = []
  let caughtFailure: unknown = null
  try {
    await withFoldStatus({ setSDKStatus: (word: unknown) => failed.push(word), abortController: new AbortController() } as never, async () => {
      throw new Error('the provider refused the fold')
    }, { trigger: 'manual', sessionMemory: false, microcompaction: true })
  } catch (e) {
    caughtFailure = e
  }
  check('a plain throw exits as a failure, never a cancel', caughtFailure instanceof Error && failed.length === 2 && compactingOf(failed[1])?.exit === 'failed', STATUS_AT + ' must stamp exit failed for any other error and rethrow it; stamps ' + JSON.stringify(failed))
  const auto: unknown[] = []
  await withFoldStatus({ setSDKStatus: (word: unknown) => auto.push(word), abortController: new AbortController() } as never, async () => 'auto', { trigger: 'auto', sessionMemory: false, microcompaction: false })
  check('the automatic road stamps its record, its landed exit, and clears with null (the turn goes on)', auto.length === 3 && compactingOf(auto[0])?.trigger === 'auto' && compactingOf(auto[1])?.exit === 'landed' && auto[2] === null, STATUS_AT + ' must, for trigger auto, stamp the record, then the landed exit, then null; stamps ' + JSON.stringify(auto))
  const bare = await withFoldStatus({} as never, async () => 'no status door', { trigger: 'manual', sessionMemory: false, microcompaction: true })
  check('a context with no status door folds unstamped and unharmed', bare === 'no status door', STATUS_AT + ' must run the work and return its answer when the context has no setSDKStatus; got ' + JSON.stringify(bare))
}

console.log('\nC8 the fold\'s record rides the word — the seat relays the stages, the fill and the exit')
{
  const record = {
    schema: 1,
    trigger: 'manual',
    startedAtMs: 1_700_000_000_000,
    stages: ['micro-compaction', 'summarising', 'restoring'],
    stage: 'summarising',
    fill: 0.25,
    summaryTokens: 5000,
    summaryCapTokens: 20_000,
    attempt: 1,
  }
  const facts = (fold: unknown): string => JSON.stringify(Object.fromEntries(Object.entries((fold ?? {}) as Record<string, unknown>).filter(([key]) => key !== 'startedAtMs' && key !== 'endedAtMs' && key !== 'schema')))
  onSeatRow(SHORT, foldRow(record), roster as never, dir)
  const stamped = tail() as { stateWord?: string; fold?: { startedAtMs?: unknown } } | null
  check("a compaction row carrying the record sets the word", stamped?.stateWord === 'compacting', JSON.stringify(stamped) + ' — ' + ROWS_AT + ' must set the word for a started or progress row that carries a record')
  check('…and the tail projection carries the record (the stages, the stage, the fill, the tokens, the attempt), its start on the seat\'s own clock', facts(stamped?.fold) === facts(record) && typeof stamped?.fold?.startedAtMs === 'number', JSON.stringify(stamped?.fold) + ' — ' + ROWS_AT + ' must store the row record on the seat and publish it in the session tail with a numeric startedAtMs')
  const moved = { ...record, stage: 'restoring', fill: null }
  onSeatRow(SHORT, foldRow(moved), roster as never, dir)
  check('a moved record republishes (the stage flipped)', facts((tail() as { fold?: unknown } | null)?.fold) === facts(moved), ROWS_AT + ' must republish the tail when the record changes, not only when the word changes')
  onSeatRow(SHORT, foldRow({ ...moved, exit: 'landed', endedAtMs: 1_700_000_009_000 }), roster as never, dir)
  check('the exit rides the record and rests the word (the fold is over; only the row reads the exit)', (tail() as { fold?: { exit?: string } } | null)?.fold?.exit === 'landed' && word() === undefined, ROWS_AT + ' must keep the record with its exit and clear the word when the record carries an exit; tail ' + JSON.stringify(tail()))
  onSeatRow(SHORT, outcome(), roster as never, dir)
  check('the outcome row retires the record with the word', word() === undefined && (tail() as { fold?: unknown } | null)?.fold === undefined, ROWS_AT + ' must clear both the word and the record on an outcome row; tail ' + JSON.stringify(tail()))
  onSeatRow(SHORT, row({ type: 'compaction', session_id: sid, turn: 1, state: 'progress', trigger: 'manual', stage: 'warming' }), roster as never, dir)
  const malformed = tail() as { stateWord?: string; fold?: unknown } | null
  check('a row whose record this build cannot read still sets the word — with no detail (the mixed-version law)', malformed?.stateWord === 'compacting' && malformed?.fold === undefined, JSON.stringify(malformed) + ' — ' + ROWS_AT + ' must set the word and drop an unreadable record instead of refusing the row')
  onSeatRow(SHORT, foldRow(null), roster as never, dir)
  const bareWord = tail() as { stateWord?: string; fold?: unknown } | null
  check('the bare started row sets the word with no detail', bareWord?.stateWord === 'compacting' && bareWord?.fold === undefined, JSON.stringify(bareWord) + ' — a started row with no record must set the word and clear the old record in ' + ROWS_AT)
  onSeatRow(SHORT, clearedRow(), roster as never, dir)
  check('the ended row clears both', word() === undefined && (tail() as { fold?: unknown } | null)?.fold === undefined, JSON.stringify(tail()) + ' — a cleared compaction row must clear the word and the record in ' + ROWS_AT)
  onSeatRow(SHORT, foldRow(record), roster as never, dir)
  onSeatSpawned(SHORT, roster as never, dir)
  check('a respawn retires the record with the word', word() === undefined && (tail() as { fold?: unknown } | null)?.fold === undefined, JSON.stringify(tail()) + ' — onSeatSpawned in src/daemon/session-seat/lifecycle.ts must clear the record as well as the word')
}

console.log("\nC8 the fold's end asks the runner for the session's facts, so the context fill the screen reads is the folded one")
{
  const asked: string[] = []
  const counting = { ...roster, door: () => ({ closed: false, request: (method: string) => { asked.push(method); return new Promise(() => undefined) } }) }
  const settled = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 450))
  onSeatRow(SHORT, foldRow(null), counting as never, dir)
  await settled()
  check('a started compaction row asks for nothing', asked.length === 0, asked.join(',') + ' — ' + ROWS_AT + ' must call requestSessionFacts only on an ended compaction row')
  onSeatRow(SHORT, clearedRow(), counting as never, dir)
  await settled()
  check('the ended row asks the runner for session/facts, once', asked.join(',') === 'session/facts', (asked.join(',') || 'nothing asked') + ' — ' + ROWS_AT + ' must call requestSessionFacts once when a compaction row ends')
  onSeatRow(SHORT, foldRow({ schema: 1, trigger: 'manual', startedAtMs: 1_700_000_000_000, stages: ['summarising', 'restoring'], stage: 'restoring', fill: null, summaryTokens: 5000, summaryCapTokens: 20_000, attempt: 1 }), counting as never, dir)
  await settled()
  check('a fold in progress asks for nothing more', asked.length === 1, asked.join(',') + ' — a progress row must not call requestSessionFacts in ' + ROWS_AT)
  onSeatRow(SHORT, foldRow({ schema: 1, trigger: 'manual', startedAtMs: 1_700_000_000_000, stages: ['summarising', 'restoring'], stage: 'restoring', fill: null, summaryTokens: 5000, summaryCapTokens: 20_000, attempt: 1, exit: 'landed', endedAtMs: 1_700_000_009_000 }), counting as never, dir)
  await settled()
  check('a fold that landed asks again: a fold outside a turn has no idle edge to ask at', asked.join(',') === 'session/facts,session/facts', asked.join(',') + ' — a compaction row that ends the fold (its record carries an exit) must call requestSessionFacts in ' + ROWS_AT)
  onSeatRow(SHORT, outcome(), counting as never, dir)
}

console.log(
  failures === 0
    ? '\n ✅ COMPACT STATE WORD — the fold speaks its own word, never the thinking dress'
    : `\n ❌ ${failures} FAILED`,
)
process.exit(failures === 0 ? 0 : 1)
