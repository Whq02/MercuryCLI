#!/usr/bin/env bun
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'stateword-home-'))

const { onSeatLine, onSeatSpawned } = await import('../../src/daemon/sessionSeat.ts')
const { readSessionTail } = await import('../../src/services/engine-connector/seatProjections.ts')
const { updateConcourseWorkers } = await import('../../src/daemon/concourseSupervisor.ts')

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
const roster = { control: () => true, list: () => [], patchSeatModel: () => true }

const statusFrame = (status: unknown): string =>
  JSON.stringify({ type: 'system', subtype: 'status', status, uuid: '00000000-0000-4000-a000-000000000001', session_id: sid })
const tail = () => readSessionTail(sid, dir)
const word = () => (tail() as { stateWord?: string } | null)?.stateWord

console.log('compact state word — the fold speaks its own word on the glass road')

console.log('\nC1 the status frame sets the word')
onSeatLine(SHORT, statusFrame('compacting'), roster as never, dir)
check("status 'compacting' ⇒ the tail projection carries the word", word() === 'compacting', JSON.stringify(tail()))

console.log('\nC2 the status null frame clears it (the restore)')
onSeatLine(SHORT, statusFrame(null), roster as never, dir)
check('status null ⇒ the word is gone', word() === undefined, JSON.stringify(tail()))

console.log('\nC3 the result frame clears it (the settle belt)')
onSeatLine(SHORT, statusFrame('compacting'), roster as never, dir)
check('the word stands before the settle', word() === 'compacting')
onSeatLine(SHORT, JSON.stringify({ type: 'result', subtype: 'success' }), roster as never, dir)
check('the result frame retires the word with the turn', word() === undefined, JSON.stringify(tail()))

console.log('\nC4 a respawn clears it (a child dead mid-fold)')
onSeatLine(SHORT, statusFrame('compacting'), roster as never, dir)
onSeatSpawned(SHORT, roster as never, dir)
check('the respawn retires the word', word() === undefined, JSON.stringify(tail()))

console.log('\nC5 a mention-shaped line never sets it')
onSeatLine(
  SHORT,
  JSON.stringify({
    type: 'assistant',
    message: { content: [{ type: 'text', text: 'the frame spelling is {"subtype":"status","status":"compacting"} verbatim' }] },
  }),
  roster as never,
  dir,
)
check('a tool/assistant line CONTAINING the token leaves no word', word() === undefined, JSON.stringify(tail()))
onSeatLine(SHORT, JSON.stringify({ type: 'result', subtype: 'success' }), roster as never, dir)

console.log('\nC6 the wiring — service stamp to glass word (structural)')
{
  const read = (rel: string): string => readFileSync(join(import.meta.dir, '..', '..', rel), 'utf8')
  const service = read('src/services/compact/compact.ts')
  check("the compact service stamps the fold's status (the record under the compacting key)", service.includes("context.setSDKStatus?.({ compacting: status })"))
  const print = read('src/cli/print.ts')
  check("the hosted child relays the stamp as a system/status frame", print.includes("subtype: 'status'"))
  const seatLive = read('src/services/engine-connector/seatLive.ts')
  check("the live-phase vocabulary carries 'compacting'", seatLive.includes("'compacting'"))
  const connector = read('src/services/engine-connector/daemonConnector.ts')
  check("the connector lifts the word into phase 'compacting'", connector.includes("'compacting'"))
  const repl = read('src/screens/REPL.tsx')
  check(
    "the REPL paints the fold's own word (its own state word, never the thinking dress)",
    repl.includes("compacting"),
  )
  check(
    "the REPL never maps the compacting phase onto the thinking mode",
    !/compacting'\s*\?\s*'thinking'/.test(repl),
  )
}

console.log('\nC7 the status covers the WHOLE fold — the entries stamp first, the one finally stamps the exit')
{
  const { withFoldStatus } = await import('../../src/services/compact/compact.ts')
  const compactingOf = (stamp: unknown): { stage?: unknown; exit?: unknown; trigger?: unknown } | null =>
    stamp !== null && typeof stamp === 'object' && 'compacting' in (stamp as object) ? ((stamp as { compacting: { stage?: unknown; exit?: unknown; trigger?: unknown } }).compacting ?? null) : null
  const stamps: unknown[] = []
  const context = { setSDKStatus: (word: unknown) => stamps.push(word), abortController: new AbortController() } as never
  const seenAtWork: unknown[] = []
  const out = await withFoldStatus(context, async () => {
    seenAtWork.push(...stamps)
    return 'folded'
  }, { trigger: 'manual', sessionMemory: false, microcompaction: true })
  check("the stamp lands BEFORE the work runs (the session-memory wait and the prompt build sit inside it)", seenAtWork.length === 1 && compactingOf(seenAtWork[0])?.stage === null)
  check("the work's answer rides through", out === 'folded')
  check('the one finally stamps the landed exit (one stamp in, one exit out)', stamps.length === 2 && compactingOf(stamps[1])?.exit === 'landed')
  const { APIUserAbortError } = await import('../../src/services/api/sdkErrors.ts')
  const thrown: unknown[] = []
  let caught: unknown = null
  try {
    await withFoldStatus({ setSDKStatus: (word: unknown) => thrown.push(word), abortController: new AbortController() } as never, async () => {
      throw new APIUserAbortError()
    }, { trigger: 'manual', sessionMemory: false, microcompaction: true })
  } catch (e) {
    caught = e
  }
  check('a cancelled fold still exits (a stamp never outlives the command) — cancelled, by its typed class', caught instanceof APIUserAbortError && thrown.length === 2 && compactingOf(thrown[1])?.exit === 'cancelled')
  const failed: unknown[] = []
  let caughtFailure: unknown = null
  try {
    await withFoldStatus({ setSDKStatus: (word: unknown) => failed.push(word), abortController: new AbortController() } as never, async () => {
      throw new Error('the provider refused the fold')
    }, { trigger: 'manual', sessionMemory: false, microcompaction: true })
  } catch (e) {
    caughtFailure = e
  }
  check('a plain throw exits as a failure, never a cancel', caughtFailure instanceof Error && failed.length === 2 && compactingOf(failed[1])?.exit === 'failed')
  const auto: unknown[] = []
  await withFoldStatus({ setSDKStatus: (word: unknown) => auto.push(word), abortController: new AbortController() } as never, async () => 'auto', { trigger: 'auto', sessionMemory: false, microcompaction: false })
  check('the automatic road stamps its record and clears with null (the turn goes on)', auto.length === 2 && compactingOf(auto[0])?.trigger === 'auto' && auto[1] === null)
  const bare = await withFoldStatus({} as never, async () => 'no status door', { trigger: 'manual', sessionMemory: false, microcompaction: true })
  check('a context with no status door folds unstamped and unharmed', bare === 'no status door')
  const read = (rel: string): string => readFileSync(join(import.meta.dir, '..', '..', rel), 'utf8')
  const command = read('src/commands/compact/compact.ts')
  check('the /compact command wraps its WHOLE body — every strategy under the status', command.includes('return withFoldStatus(context, scoped => callUnderFoldStatus(args, scoped), {'))
  const autoRoad = read('src/services/compact/autoCompact.ts')
  check('the automatic road wraps its fold under the status once the decision is made', autoRoad.includes('return await withFoldStatus(toolUseContext, async scoped => {'))
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
  onSeatLine(SHORT, statusFrame({ compacting: record }), roster as never, dir)
  const stamped = tail() as { stateWord?: string; fold?: unknown } | null
  check("a status frame carrying the record sets the word", stamped?.stateWord === 'compacting', JSON.stringify(stamped))
  check('…and the tail projection carries the record, verbatim', JSON.stringify(stamped?.fold) === JSON.stringify(record), JSON.stringify(stamped?.fold))
  const moved = { ...record, stage: 'restoring', fill: null }
  onSeatLine(SHORT, statusFrame({ compacting: moved }), roster as never, dir)
  check('a moved record republishes (the stage flipped)', JSON.stringify((tail() as { fold?: unknown } | null)?.fold) === JSON.stringify(moved))
  onSeatLine(SHORT, statusFrame({ compacting: { ...moved, exit: 'landed', endedAtMs: 1_700_000_009_000 } }), roster as never, dir)
  check('the exit rides the same word', (tail() as { fold?: { exit?: string } } | null)?.fold?.exit === 'landed' && word() === 'compacting')
  onSeatLine(SHORT, JSON.stringify({ type: 'result', subtype: 'success' }), roster as never, dir)
  check('the result frame retires the record with the word', word() === undefined && (tail() as { fold?: unknown } | null)?.fold === undefined)
  onSeatLine(SHORT, statusFrame({ compacting: { schema: 7, stage: 'warming' } }), roster as never, dir)
  const malformed = tail() as { stateWord?: string; fold?: unknown } | null
  check('a record this build cannot read still sets the word — with no detail (the mixed-version law)', malformed?.stateWord === 'compacting' && malformed?.fold === undefined, JSON.stringify(malformed))
  onSeatLine(SHORT, statusFrame('compacting'), roster as never, dir)
  const bareWord = tail() as { stateWord?: string; fold?: unknown } | null
  check('the bare word (an older runner) sets the word with no detail', bareWord?.stateWord === 'compacting' && bareWord?.fold === undefined)
  onSeatLine(SHORT, statusFrame(null), roster as never, dir)
  check('null clears both', word() === undefined && (tail() as { fold?: unknown } | null)?.fold === undefined)
  onSeatLine(SHORT, statusFrame({ compacting: record }), roster as never, dir)
  onSeatSpawned(SHORT, roster as never, dir)
  check('a respawn retires the record with the word', word() === undefined && (tail() as { fold?: unknown } | null)?.fold === undefined)
}

console.log(
  failures === 0
    ? '\n ✅ COMPACT STATE WORD — the fold speaks its own word, never the thinking dress'
    : `\n ❌ ${failures} FAILED`,
)
process.exit(failures === 0 ? 0 : 1)
