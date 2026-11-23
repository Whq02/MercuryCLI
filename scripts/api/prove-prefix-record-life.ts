#!/usr/bin/env bun
import { existsSync, mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

if (process.env.NODE_ENV === 'test') delete process.env.NODE_ENV
process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'prefix-record-life-'))
process.env.ANTHROPIC_API_KEY = 'sk-ant-fixture-not-a-real-key'
delete process.env.MERCURY_PREFIX_RECORD_RETENTION_DAYS
delete process.env.MERCURY_THINKING_BINDING
delete process.env.MERCURY_PREFIX_INDUCE_EDIT
delete process.env.MERCURY_SKIP_PROMPT_HISTORY
delete process.env.ANTHROPIC_BASE_URL
delete process.env.MERCURY_HOME
delete process.env.CI
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0', PACKAGE_URL: 'https://github.com/example/mercury' }

const ROOT = resolve(import.meta.dir, '..', '..')
const HOME = process.env.MERCURY_CONFIG_DIR!
const MODEL = 'claude-fable-5-1'
const DAY_MS = 24 * 60 * 60 * 1000

let failures = 0
let checks = 0
function check(label: string, cond: boolean, detail = ''): void {
  checks++
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}
const j = (v: unknown): string => JSON.stringify(v)
const read = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8')
const tick = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))
function readJson(path: string): Record<string, unknown> {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
  } catch {
    return {}
  }
}
function ageFile(path: string, days: number, now = Date.now()): void {
  const at = new Date(now - days * DAY_MS)
  utimesSync(path, at, at)
}

const guard = setTimeout(() => {
  console.log('\n❌ TIMEOUT — prefix record life proofs exceeded 120s; a flush or sweep never returned, look at flushPrefixLedger in src/models/roads/anthropic/prefixLedger.ts and sweepPrefixRecords in src/models/roads/anthropic/prefixRecordStore.ts')
  process.exit(1)
}, 120_000)
guard.unref?.()

const { enableConfigs } = await import('../../src/platform/config/globalConfig.ts')
enableConfigs()
const ledger = await import('../../src/models/roads/anthropic/prefixLedger.ts')
const binding = await import('../../src/models/roads/anthropic/thinkingBinding.ts')
const resolveOwner = await import('../../src/engine/run-owner/resolveOwner.ts')
const state = await import('../../src/boot/process-state/processState.ts')
const paths = await import('../../src/sessions/transcripts/paths.ts')
const cleanup = await import('../../src/platform/processes/cleanupRegistry.ts')
const registry = await import('../../src/platform/substrate/flagRegistry.ts')

interface SweepReceipt { seen: number; kept: number; live: number; expired: string[]; orphaned: string[] }
interface Store {
  PREFIX_LEDGER_FILE: string
  PREFIX_RECORD_RETENTION_DAYS_DEFAULT: number
  prefixLedgerPath: (sessionId?: string, home?: string) => string
  prefixRecordRetentionDays: () => number
  removePrefixRecord: (sessionId: string, home?: string) => { record: boolean; folder: boolean }
  sweepPrefixRecords: (options?: { home?: string; liveSessionIds?: Iterable<string>; now?: number }) => Promise<SweepReceipt>
}
let store: Partial<Store> = {}
try {
  store = (await import('../../src/models/roads/anthropic/prefixRecordStore.ts')) as unknown as Store
} catch {
  store = {}
}
const L = ledger as unknown as {
  noteRequestOnWire?: (owner: string) => void
  flushPrefixLedger?: () => Promise<void>
  prefixLedgerWriterState?: () => { pending: boolean; held: boolean; writes: number }
}
const onWire = (owner: string): void => L.noteRequestOnWire?.(owner)
const flush = async (): Promise<void> => {
  await L.flushPrefixLedger?.()
}
const writerState = (): { pending: boolean; held: boolean; writes: number } => L.prefixLedgerWriterState?.() ?? { pending: false, held: false, writes: -1 }
const removeRecord = (sessionId: string, home?: string): { record: boolean; folder: boolean } => store.removePrefixRecord?.(sessionId, home) ?? { record: false, folder: false }
const sweep = async (options: { home?: string; liveSessionIds?: Iterable<string>; now?: number }): Promise<SweepReceipt> =>
  (await store.sweepPrefixRecords?.(options)) ?? { seen: -1, kept: -1, live: -1, expired: [], orphaned: [] }

const owner = String(resolveOwner.processMainOwner())
const sessionId = String(state.getSessionId())
const key = `${owner}|first-row|${MODEL}`
const recordPath = store.prefixLedgerPath?.(sessionId) ?? join(HOME, 'sessions', sessionId, 'prefix-ledger.json')
const SYSTEM = [{ type: 'text', text: 'You are Mercury.\n\n# Environment\n - Platform: darwin\n' }]
const TOOLS = [{ name: 'Read', description: 'Read tool', input_schema: { type: 'object', properties: {} } }]
type Row = Record<string, unknown>
function history(rounds: number): { rows: Row[]; ids: Array<string | null> } {
  const rows: Row[] = [{ role: 'user', content: [{ type: 'text', text: 'prompt' }] }]
  const ids: Array<string | null> = [null]
  for (let r = 1; r <= rounds; r++) {
    rows.push({ role: 'assistant', content: [{ type: 'thinking', thinking: `think ${r}`, signature: `sig-${r}` }, { type: 'tool_use', id: `toolu_${r}`, name: 'Read', input: { file_path: `f${r}` } }] })
    ids.push(`msg_${r}`)
    rows.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: `toolu_${r}`, content: `result ${r}` }] })
    ids.push(null)
  }
  return { rows, ids }
}
const judge = (h: { rows: Row[]; ids: Array<string | null> }): ReturnType<typeof ledger.judgeAndRecordPrefix> =>
  ledger.judgeAndRecordPrefix(owner, key, { system: SYSTEM, tools: TOOLS, messages: h.rows }, h.ids)
const fresh = (): void => {
  ledger.resetPrefixLedger()
  binding.resetThinkingDropStates()
}
const messagesOnDisk = (): number => ((readJson(recordPath).record as { messages?: unknown[] } | undefined)?.messages ?? []).length

section('§1 the write leaves the request path: one coalesced background write, landed once the request is on the wire')
fresh()
check('the record store names the place: <config home>/sessions/<session id>/prefix-ledger.json', recordPath === join(HOME, 'sessions', sessionId, 'prefix-ledger.json') && typeof store.prefixLedgerPath === 'function', recordPath + '; prefixLedgerPath in src/models/roads/anthropic/prefixRecordStore.ts must return <config home>/sessions/<session id>/prefix-ledger.json')
check("the ledger re-exports the place under its old name (the resume proof's road)", (ledger as unknown as { prefixLedgerPath?: unknown }).prefixLedgerPath === store.prefixLedgerPath, 'src/models/roads/anthropic/prefixLedger.ts must re-export prefixLedgerPath from prefixRecordStore.ts')
const r1 = history(1)
const first = judge(r1)
check('the first request of a process is judged without a record (compared false)', !first.compared && first.mismatch === null, j(first) + '; judgeAndRecordPrefix in src/models/roads/anthropic/prefixLedger.ts must return compared false and mismatch null when no record exists')
const s0 = writerState()
check('a judged request marks the record dirty and holds the write for the wire: nothing on disk', s0.pending && s0.held && !existsSync(recordPath), j(s0) + '; judgeAndRecordPrefix must mark the writer pending and held, and nothing may be written before noteRequestOnWire (src/models/roads/anthropic/prefixLedger.ts)')
await tick(30)
check('a tick later still nothing: the writer never lands a body before its request is on the wire', !existsSync(recordPath) && writerState().writes === 0, j(writerState()) + '; the writer in src/models/roads/anthropic/prefixLedger.ts must wait for noteRequestOnWire before it writes')
onWire(owner)
const r2 = history(2)
judge(r2)
onWire(owner)
const r3 = history(3)
judge(r3)
onWire(owner)
await flush()
const s1 = writerState()
check('three quick requests land ONE file write', s1.writes === 1 && !s1.pending && !s1.held, j(s1) + '; noteRequestOnWire and flushPrefixLedger in src/models/roads/anthropic/prefixLedger.ts must coalesce quick requests into one write')
const body1 = readJson(recordPath) as { owner?: string; transcript?: unknown; record?: { key?: string; messages?: unknown[]; wireMessageIds?: unknown } }
check('…carrying the last body: the third request, its rows and its wire ids', body1.record?.messages?.length === r3.rows.length && j(body1.record?.wireMessageIds) === j(r3.ids), j(body1.record?.wireMessageIds) + '; the written body must be the last judged request (judgeAndRecordPrefix in src/models/roads/anthropic/prefixLedger.ts)')
check('the record names the owner and the conversation key', body1.owner === owner && body1.record?.key === key, j({ owner: body1.owner, key: body1.record?.key }) + '; the record written by src/models/roads/anthropic/prefixLedger.ts must carry owner and key')
check('a record written before the transcript exists carries no transcript stamp (a fresh orphan, by design)', body1.transcript === undefined && !existsSync(paths.getTranscriptPath()), j(body1.transcript) + '; transcriptStamp in src/models/roads/anthropic/prefixLedger.ts must return null while the transcript file does not exist')
const transcriptPath = paths.getTranscriptPath()
mkdirSync(dirname(transcriptPath), { recursive: true })
writeFileSync(transcriptPath, '{"type":"user","uuid":"u1"}\n')
const r4 = history(4)
judge(r4)
onWire(owner)
await flush()
const body2 = readJson(recordPath) as { transcript?: unknown }
const head = readFileSync(recordPath, 'utf8').slice(0, 512)
check('a write made while the transcript stands stamps its path into the head of the record', body2.transcript === transcriptPath && head.includes('"transcript":'), head.slice(0, 200) + '; transcriptStamp in src/models/roads/anthropic/prefixLedger.ts must stamp the transcript path, and the stamp must sit in the first 512 bytes of the record')
ledger.rememberDropState(owner, { kind: 'first', consecutive: 1, defectNoticed: false, editNoticed: false, mark: { model: MODEL, settings: 's' } })
const s2 = writerState()
check('the drop state recorded after a response is dirty without a hold: the request it belongs to is already on the wire', s2.pending && !s2.held, j(s2) + '; rememberDropState in src/models/roads/anthropic/prefixLedger.ts must mark the record dirty without holding it')
await flush()
check('…and lands on its own tick', writerState().writes === 3 && (readJson(recordPath).drops as { kind?: string } | null)?.kind === 'first', j(writerState()) + '; flushPrefixLedger in src/models/roads/anthropic/prefixLedger.ts must land the drop state in one more write')
check('a repeat of the request already recorded (a retry, the logging pass) marks nothing', (judge(r4), !writerState().pending && !writerState().held), j(writerState()) + '; judgeAndRecordPrefix in src/models/roads/anthropic/prefixLedger.ts must not mark a repeat of the recorded request')

section('§2 a write pending when the process exits lands at cleanup — the registration the live-process registry uses')
const r5 = history(5)
judge(r5)
onWire(owner)
const s3 = writerState()
check('the write is pending for the next tick', s3.pending && !s3.held, j(s3) + '; noteRequestOnWire in src/models/roads/anthropic/prefixLedger.ts must release the hold and leave the write pending')
await cleanup.runCleanupFunctions().catch(() => {})
check('the cleanup registry flushed it: the record on disk is the pending body', !writerState().pending && messagesOnDisk() === r5.rows.length, `${messagesOnDisk()} rows on disk; the registerCleanup(flushPrefixLedger) call in src/models/roads/anthropic/prefixLedger.ts must flush the pending write at exit`)
const r6 = history(6)
judge(r6)
await cleanup.runCleanupFunctions().catch(() => {})
check('a body whose request never reached the wire is not flushed at exit: the previous record stands', messagesOnDisk() === r5.rows.length && writerState().held, `${messagesOnDisk()} rows on disk; ${j(writerState())}; the exit flush in src/models/roads/anthropic/prefixLedger.ts must skip a body still held for the wire`)

section('§3 a record a request behind is read back: the verdict carries the lag; the receipt and the health row say so and name no part')
const seed = async (rounds: number): Promise<void> => {
  fresh()
  judge(history(rounds))
  onWire(owner)
  await flush()
  fresh()
}
const editRow2 = (h: { rows: Row[]; ids: Array<string | null> }): { rows: Row[]; ids: Array<string | null> } => ({
  rows: h.rows.map((row, i) => (i === 2 ? { ...row, content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'result 1 (edited)' }] } : row)),
  ids: h.ids,
})
await seed(2)
const inStep = judge(editRow2(history(3)))
check('control — one response landed since the record: the fresh process compares in step and names the edited row', inStep.compared && inStep.behind === 0 && inStep.mismatch?.part === "turn 2's user row: tool_result block 0", j(inStep.mismatch) + '; judgeAndRecordPrefix in src/models/roads/anthropic/prefixLedger.ts must read the record back and name the edited part')
await seed(2)
const behind = judge(editRow2(history(4)))
check('two responses landed since the record: the fresh process sees from the wire ids that the record is a request behind', behind.compared && behind.behind === 1, j({ compared: behind.compared, behind: behind.behind }) + '; judgeAndRecordPrefix must count requests behind from the wire message ids (src/models/roads/anthropic/prefixLedger.ts)')
check('…and names no part: the rows between the record and the history were never recorded', behind.mismatch === null, j(behind.mismatch) + '; judgeAndRecordPrefix in src/models/roads/anthropic/prefixLedger.ts must name no part when the record is behind')
const drops = [{ type: 'thinking_dropped', path: 'messages.1.content.0', reason: 'prefix_binding_mismatch' }]
const outcome = { kind: 'first', lawful: null, detail: null, rosterChange: null, consecutive: 1, count: 1, path: 'messages.1.content.0', reason: 'prefix_binding_mismatch', paint: true, part: null, behind: behind.behind }
const words = binding.describeThinkingDrops(drops as never, outcome as never) ?? ''
check('the receipt says the record was a request behind, and never "names the part that moved"', words.includes('1 request behind') && words.includes('previous process ended before its last write') && !words.includes('names the part that moved'), words + '; describeThinkingDrops in src/models/roads/anthropic/thinkingBinding.ts must say the record was behind when outcome.behind is set')
binding.recordThinkingDropLedger(outcome as never, MODEL, words, sessionId)
const health = binding.preservedThinkingHealth(binding.readThinkingDropLedger(), sessionId)
check("/health's row says the record was behind and names no part", health.evidence.includes('1 request behind') && !health.evidence.includes('named the part'), health.evidence + '; preservedThinkingHealth in src/models/roads/anthropic/thinkingBinding.ts must report the lag and name no part')
const healthRow = readJson(join(HOME, 'preserved-thinking.json')) as { last?: { behind?: unknown; part?: unknown } }
check('the health ledger keeps the lag as a number and no part', healthRow.last?.behind === 1 && healthRow.last?.part === undefined, j(healthRow.last) + '; recordThinkingDropLedger in src/models/roads/anthropic/thinkingBinding.ts must store behind as a number and no part')
await seed(2)
const further = judge(history(5))
check('three responses landed: two requests behind', further.behind === 2 && further.mismatch === null, j({ behind: further.behind }) + '; judgeAndRecordPrefix in src/models/roads/anthropic/prefixLedger.ts must count requests behind from the wire message ids')

section('§4 the record goes with its session: removed from the board or pruned, the record and an emptied folder go too')
const s2Id = 'c0ffee00-0000-4000-8000-000000000002'
const f2 = join(HOME, 'sessions', s2Id)
mkdirSync(f2, { recursive: true })
writeFileSync(join(f2, 'prefix-ledger.json'), '{"version":1}')
writeFileSync(join(f2, 'prefix-ledger.json.999999.tmp'), '{}')
const rm2 = removeRecord(s2Id)
check("the record and a dead process's staging file go, and the emptied folder with them", rm2.record && rm2.folder && !existsSync(f2), j(rm2) + '; removePrefixRecord in src/models/roads/anthropic/prefixRecordStore.ts must remove the record, the staging file and the emptied folder')
const s3Id = 'c0ffee00-0000-4000-8000-000000000003'
const f3 = join(HOME, 'sessions', s3Id)
mkdirSync(f3, { recursive: true })
writeFileSync(join(f3, 'prefix-ledger.json'), '{"version":1}')
writeFileSync(join(f3, 'computer-grant.json'), '{}')
const rm3 = removeRecord(s3Id)
check('a folder that still holds something else (the computer-use grant) stays; the record alone is gone', rm3.record && !rm3.folder && existsSync(join(f3, 'computer-grant.json')) && !existsSync(join(f3, 'prefix-ledger.json')), j(rm3) + '; removePrefixRecord in src/models/roads/anthropic/prefixRecordStore.ts must remove only the record when the folder holds other files')
check('removing a record that is not there is a quiet no-op', !removeRecord(s2Id).record && !removeRecord('never-a-session').record, 'removePrefixRecord in src/models/roads/anthropic/prefixRecordStore.ts must return record false for a record that is not there')

section("§5 the boot sweep: an orphan and an expired record go; a live session's record and a fresh orphan under the retention stay; the verdict is the flag's")
const home2 = mkdtempSync(join(tmpdir(), 'prefix-record-sweep-'))
const transcripts = join(home2, 'projects', 'p')
mkdirSync(transcripts, { recursive: true })
const plant = (name: string, options: { transcript?: 'present' | 'gone'; ageDays?: number; body?: string }): string => {
  const folder = join(home2, 'sessions', name)
  mkdirSync(folder, { recursive: true })
  let stamp = ''
  if (options.transcript !== undefined) {
    const t = join(transcripts, `${name}.jsonl`)
    if (options.transcript === 'present') writeFileSync(t, '{}\n')
    stamp = `,"transcript":${j(t)}`
  }
  const file = join(folder, 'prefix-ledger.json')
  writeFileSync(file, options.body ?? `{"version":1,"owner":"o"${stamp},"record":{"key":"k","whole":"w","system":[],"tools":[],"messages":[],"wireMessageIds":[],"dropped":[]},"drops":null}`)
  if (options.ageDays !== undefined) ageFile(file, options.ageDays)
  return folder
}
const liveFolder = plant('live-daemon', { transcript: 'present', ageDays: 100 })
const pidFolder = plant('live-pid', { transcript: 'gone', ageDays: 100 })
writeFileSync(join(home2, 'sessions', `${process.pid}.json`), j({ pid: process.pid, sessionId: 'live-pid', cwd: '/', startedAt: 0, kind: 'interactive' }))
const expiredFolder = plant('expired', { transcript: 'present', ageDays: 40 })
const orphanFolder = plant('orphan', { transcript: 'gone', ageDays: 2 })
const freshOrphanFolder = plant('fresh-orphan', {})
const stampedFreshFolder = plant('stamped-fresh', { transcript: 'present', ageDays: 3 })
const legacyFolder = plant('legacy-unstamped', { ageDays: 10 })
mkdirSync(join(home2, 'sessions', 'samples-only', 'samples'), { recursive: true })
writeFileSync(join(home2, 'sessions', 'stray.txt'), 'x')
const receipt = await sweep({ home: home2, liveSessionIds: ['live-daemon'] })
check('the sweep saw every record once and counted the two live ones', receipt.seen === 7 && receipt.live === 2, j(receipt) + '; sweepPrefixRecords in src/models/roads/anthropic/prefixRecordStore.ts must count every record and the live ones from liveSessionIds and the pid registry')
check("a live session's record is never touched, however old (the daemon's live set and the pid registry)", existsSync(join(liveFolder, 'prefix-ledger.json')) && existsSync(join(pidFolder, 'prefix-ledger.json')), 'sweepPrefixRecords in src/models/roads/anthropic/prefixRecordStore.ts must skip sessions in liveSessionIds and in the pid registry')
check('an expired record goes with its emptied folder', receipt.expired.includes('expired') && !existsSync(expiredFolder), j(receipt.expired) + '; sweepPrefixRecords in src/models/roads/anthropic/prefixRecordStore.ts must remove a record older than the retention')
check('an orphan — its transcript no longer exists — goes at any age', receipt.orphaned.includes('orphan') && !existsSync(orphanFolder), j(receipt.orphaned) + '; sweepPrefixRecords in src/models/roads/anthropic/prefixRecordStore.ts must remove a record whose stamped transcript is gone')
check('a fresh orphan under the retention — no transcript stamp yet — is left alone', existsSync(join(freshOrphanFolder, 'prefix-ledger.json')), 'sweepPrefixRecords in src/models/roads/anthropic/prefixRecordStore.ts must keep an unstamped record under the retention')
check('a stamped record whose transcript stands is left alone', existsSync(join(stampedFreshFolder, 'prefix-ledger.json')), 'sweepPrefixRecords in src/models/roads/anthropic/prefixRecordStore.ts must keep a record whose stamped transcript still exists')
check('an unstamped record under the retention is left alone (an older build wrote it)', existsSync(join(legacyFolder, 'prefix-ledger.json')), 'sweepPrefixRecords in src/models/roads/anthropic/prefixRecordStore.ts must keep an unstamped record under the retention')
check('a folder without a record and a stray file are not the sweep\'s business', existsSync(join(home2, 'sessions', 'samples-only', 'samples')) && existsSync(join(home2, 'sessions', 'stray.txt')) && receipt.kept === 5, j(receipt) + '; sweepPrefixRecords in src/models/roads/anthropic/prefixRecordStore.ts must ignore folders without a record and stray files')
check('the transcripts themselves are untouched (the sweep never walks or deletes under projects)', existsSync(join(transcripts, 'expired.jsonl')) && existsSync(join(transcripts, 'stamped-fresh.jsonl')) && existsSync(join(transcripts, 'live-daemon.jsonl')), 'sweepPrefixRecords in src/models/roads/anthropic/prefixRecordStore.ts must never delete under projects')
delete process.env.MERCURY_PREFIX_RECORD_RETENTION_DAYS
check("unset, the retention is the product's thirty days", store.prefixRecordRetentionDays?.() === 30 && store.PREFIX_RECORD_RETENTION_DAYS_DEFAULT === 30, 'prefixRecordRetentionDays and PREFIX_RECORD_RETENTION_DAYS_DEFAULT in src/models/roads/anthropic/prefixRecordStore.ts must give 30 with the flag unset')
process.env.MERCURY_PREFIX_RECORD_RETENTION_DAYS = '7'
check('the retention reads the flag', store.prefixRecordRetentionDays?.() === 7, 'prefixRecordRetentionDays in src/models/roads/anthropic/prefixRecordStore.ts must read MERCURY_PREFIX_RECORD_RETENTION_DAYS')
process.env.MERCURY_PREFIX_RECORD_RETENTION_DAYS = '0'
check('a value below one day reads as unset', store.prefixRecordRetentionDays?.() === 30, 'prefixRecordRetentionDays in src/models/roads/anthropic/prefixRecordStore.ts must fall back to the default below one day')
process.env.MERCURY_PREFIX_RECORD_RETENTION_DAYS = 'soon'
check('a value that is not a whole number reads as unset', store.prefixRecordRetentionDays?.() === 30, 'prefixRecordRetentionDays in src/models/roads/anthropic/prefixRecordStore.ts must fall back to the default for a non-integer')
delete process.env.MERCURY_PREFIX_RECORD_RETENTION_DAYS
const spec = registry.getFlagSpec('MERCURY_PREFIX_RECORD_RETENTION_DAYS')
const home3 = mkdtempSync(join(tmpdir(), 'prefix-record-flag-'))
const plantAged = (): string => {
  const folder = join(home3, 'sessions', 'aged')
  mkdirSync(folder, { recursive: true })
  const file = join(folder, 'prefix-ledger.json')
  writeFileSync(file, '{"version":1,"owner":"o","record":{},"drops":null}')
  ageFile(file, 40)
  return file
}
let aged = plantAged()
await sweep({ home: home3 })
check('a record 40 days old is removed under the thirty-day default', !existsSync(aged), 'sweepPrefixRecords in src/models/roads/anthropic/prefixRecordStore.ts must expire a record older than prefixRecordRetentionDays')
aged = plantAged()
process.env.MERCURY_PREFIX_RECORD_RETENTION_DAYS = '90'
await sweep({ home: home3 })
check('a changed flag changes the verdict: under ninety days the same record stays', existsSync(aged), 'sweepPrefixRecords in src/models/roads/anthropic/prefixRecordStore.ts must read MERCURY_PREFIX_RECORD_RETENTION_DAYS on each sweep')
await sweep({ home: home3, now: Date.now() + 30 * DAY_MS })
check('a changed clock alone does not: thirty days later the record, now 70 days old, still stands under the flag', existsSync(aged), 'sweepPrefixRecords in src/models/roads/anthropic/prefixRecordStore.ts must judge age by the record file time against the now option and the flag')
process.env.MERCURY_PREFIX_RECORD_RETENTION_DAYS = '5'
await sweep({ home: home3 })
check('the flag brought under the record\'s age removes it, the clock unmoved', !existsSync(aged), 'sweepPrefixRecords in src/models/roads/anthropic/prefixRecordStore.ts must read the flag afresh and remove a record older than it')
delete process.env.MERCURY_PREFIX_RECORD_RETENTION_DAYS
const docs = read('docs/SESSIONS.md')
check('the sessions page says where the record lives, what it holds, when it is written and when it is removed', docs.includes('prefix-ledger.json') && docs.includes('MERCURY_PREFIX_RECORD_RETENTION_DAYS') && /never a word of\s+the conversation/.test(docs) && /on the wire/.test(docs), 'docs/SESSIONS.md must name prefix-ledger.json and MERCURY_PREFIX_RECORD_RETENTION_DAYS, say the record holds never a word of the conversation, and say it is written on the wire')

console.log(`\n${failures === 0 ? '✅' : '❌'} prefix record life: ${checks - failures}/${checks} checks passed`)
clearTimeout(guard)
process.exit(failures === 0 ? 0 : 1)
