#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { appendFileSync, copyFileSync, existsSync, linkSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { removeScratch } from '../lib/removeScratch.ts'

const REPO = join(import.meta.dir, '..', '..')
const SRC = join(REPO, 'src')
const DIST = process.env.MERCURY_PROOF_DIST ?? join(REPO, 'dist', 'mercury.mjs')
const NODE = (spawnSync('which', ['node'], { encoding: 'utf8' }).stdout ?? '').trim()
const KEEP = process.env.SCREEN_REPLAY_KEEP === '1'

let failures = 0
let checks = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  checks++
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
const section = (t: string): void => console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
const j = (v: unknown): string => JSON.stringify(v)
const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))
const untilAsync = async (pred: () => Promise<boolean> | boolean, ms: number, everyMs = 150): Promise<boolean> => {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    try {
      if (await pred()) return true
    } catch {}
    await sleep(everyMs)
  }
  return false
}
const guard = setTimeout(() => {
  console.log('\n❌ TIMEOUT — prove-screen-replay-after-compact exceeded 480s')
  process.exit(1)
}, 480_000)
guard.unref?.()

const SCRATCH = realpathSync(mkdtempSync(join(tmpdir(), 'screen-replay-after-compact-')))
const home = join(SCRATCH, 'home')
const daemonDir = join(SCRATCH, 'daemon')
const work = join(SCRATCH, 'work')
const runtime = join(home, 'runtime')
const builds = join(runtime, 'builds')
for (const d of [home, daemonDir, work, builds]) mkdirSync(d, { recursive: true })
process.chdir(work)
process.env.TMPDIR = '.'

process.env.MERCURY_CONFIG_DIR = home
process.env.MERCURY_DAEMON_DIR = daemonDir
process.env.MERCURY_CREDENTIAL_STORE = 'file'
for (const k of ['MERCURY_HOME', 'MERCURY_CREW_DIR', 'MERCURY_DAEMON_OWNER_PID', 'MERCURY_DAEMON_OWNER_FD', 'MERCURY_DAEMON_PERSIST', 'MERCURY_DAEMON_SUCCESSOR_OF', 'MERCURY_DAEMON_HANDOVER_FROM', 'NODE_ENV']) {
  delete process.env[k]
}

type Entry = { type: string; uuid: string; parentUuid: string | null; timestamp: string; subtype?: string; message?: { content?: unknown }; compactMetadata?: { preservedSegment?: { headUuid: string; anchorUuid: string; tailUuid: string } } }
const vnext = await import(join(SRC, 'utils/sessionStorage/vnext.ts'))
const reader = await import(join(SRC, 'utils/sessionStorage/transcriptReader.ts'))
const decode = await import(join(SRC, 'fabric/transcriptDecode.ts'))
const factories = await import(join(SRC, 'utils/messages/factories.ts'))
const compactMod = await import(join(SRC, 'utils/messages/systemMessages.ts'))

const CHAIN_TYPES = new Set(['user', 'assistant', 'system', 'attachment'])

type RecordLine = { recordId: string; updates?: string; payload?: { kind?: string } }
function recordLines(path: string): RecordLine[] {
  const out: RecordLine[] = []
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (line === '') continue
    try {
      out.push(JSON.parse(line) as RecordLine)
    } catch {}
  }
  return out
}
function entriesOf(path: string): Entry[] {
  const decoded = decode.decodeTranscriptBuffer(readFileSync(path)) as { entries: Entry[] }
  return decoded.entries.filter(e => CHAIN_TYPES.has(e.type))
}
function createdTwice(path: string): string[] {
  const seen = new Map<string, number>()
  for (const rec of recordLines(path)) {
    if (rec.updates !== undefined) continue
    if (rec.payload?.kind === 'session-meta') continue
    seen.set(rec.recordId, (seen.get(rec.recordId) ?? 0) + 1)
  }
  return [...seen].filter(([, n]) => n > 1).map(([id]) => id)
}

type Epoch = { boundary: string; preserved: string[]; after: string[]; all: Set<string> }
function epochOf(entries: Entry[]): Epoch | null {
  const latest = new Map<string, Entry>()
  const firstAt = new Map<string, number>()
  entries.forEach((e, i) => {
    latest.set(e.uuid, e)
    if (!firstAt.has(e.uuid)) firstAt.set(e.uuid, i)
  })
  const boundaries = [...latest.values()]
    .filter(e => e.type === 'system' && e.subtype === 'compact_boundary')
    .sort((a, b) => firstAt.get(a.uuid)! - firstAt.get(b.uuid)!)
  const boundary = boundaries.at(-1)
  if (boundary === undefined) return null
  const parentOf = new Map<string, string | null>()
  for (const e of latest.values()) parentOf.set(e.uuid, e.parentUuid)
  let preserved: string[] = []
  for (const row of boundaries) {
    const segment = row.compactMetadata?.preservedSegment
    if (segment === undefined) continue
    const kept: string[] = []
    let cursor: string | undefined = latest.has(segment.tailUuid) ? segment.tailUuid : undefined
    while (cursor !== undefined && !kept.includes(cursor)) {
      kept.unshift(cursor)
      if (cursor === segment.headUuid) break
      const parent = parentOf.get(cursor)
      cursor = parent !== null && parent !== undefined && latest.has(parent) ? parent : undefined
    }
    if (kept[0] !== segment.headUuid) continue
    parentOf.set(segment.headUuid, segment.anchorUuid)
    for (const [id, parent] of parentOf) if (parent === segment.anchorUuid && id !== segment.headUuid) parentOf.set(id, segment.tailUuid)
    if (row === boundary) preserved = kept
  }
  const floor = firstAt.get(boundary.uuid)!
  let leafAt = -1
  for (const [id, at] of firstAt) {
    const type = latest.get(id)!.type
    if ((type === 'user' || type === 'assistant') && at > leafAt) leafAt = at
  }
  const after = [...firstAt].filter(([id, at]) => at > floor && at <= leafAt && id !== boundary.uuid).sort((a, b) => a[1] - b[1]).map(([id]) => id)
  return { boundary: boundary.uuid, preserved, after, all: new Set([boundary.uuid, ...preserved, ...after]) }
}

function textOf(row: { type?: string; message?: { content?: unknown } }): string {
  const content = row.message?.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return (content as Array<{ type?: string; text?: string }>).map(b => (b.type === 'text' && typeof b.text === 'string' ? b.text : '')).join('\n')
}

function judgeScreen(label: string, screenRows: ReadonlyArray<{ uuid: string; type?: string; message?: { content?: unknown } }>, recordPath: string, words: string[]): void {
  const entries = entriesOf(recordPath)
  const onDisk = new Set(entries.map(e => e.uuid))
  const ids = screenRows.map(r => r.uuid)
  const foreign = ids.filter(id => !onDisk.has(id))
  check(`${label}: every row on the screen is a record of the file (no echo or ghost left behind)`, foreign.length === 0, j(foreign))
  const dupes = ids.filter((id, i) => ids.indexOf(id) !== i)
  check(`${label}: no record is painted twice`, dupes.length === 0, j(dupes))
  const epoch = epochOf(entries)
  if (epoch === null) {
    check(`${label}: the record has a compaction boundary to judge against`, false)
    return
  }
  const painted = new Set(ids)
  const missing = [...epoch.all].filter(id => !painted.has(id))
  const extra = ids.filter(id => !epoch.all.has(id))
  check(`${label}: the screen holds the newest compaction's boundary, its kept tail and every record after it — once each (${epoch.all.size} records)`, missing.length === 0 && extra.length === 0, j({ missing: missing.slice(0, 8), extra: extra.slice(0, 8), screen: ids.length, epoch: epoch.all.size }))
  const afterOnScreen = ids.filter(id => epoch.after.includes(id))
  check(`${label}: the records after the compaction paint in the order the file holds them`, j(afterOnScreen) === j(epoch.after), j({ screen: afterOnScreen.slice(-6), file: epoch.after.slice(-6) }))
  check(`${label}: the boundary row paints first`, ids[0] === epoch.boundary, j(ids.slice(0, 3)))
  const text = screenRows.map(textOf).join('\n')
  const absent = words.filter(w => !text.includes(w))
  check(`${label}: every word sent and every reply received after the compaction is on the screen`, absent.length === 0, j(absent))
}

section('§A the reader law — a record re-emitted after a compaction never moves or prunes the live rows (the owner\'s record, synthesized)')
{
  const dir = join(SCRATCH, 'reader')
  mkdirSync(dir, { recursive: true })
  const path = join(dir, `${randomUUID()}.jsonl`)
  let clock = Date.parse('2026-10-20T02:00:00.000Z')
  const tick = (): string => new Date((clock += 1000)).toISOString()
  type Row = Record<string, unknown> & { uuid: string }
  const user = (text: string, parentUuid: string | null): Row => ({ ...(factories.createUserMessage({ content: text }) as Row), parentUuid, isSidechain: false, timestamp: tick() })
  const assistant = (text: string, parentUuid: string | null): Row => ({ ...(factories.createAssistantMessage({ content: [{ type: 'text', text }] }) as Row), parentUuid, isSidechain: false, timestamp: tick() })
  const write = (rows: Row[]): void => {
    for (const row of rows) appendFileSync(path, (vnext.encodeTranscriptLine(path, row) as { line: string }).line)
  }
  const u1 = user('the first words, folded', null)
  const a1 = assistant('the first reply, folded', u1.uuid)
  const u2 = user('the kept words', a1.uuid)
  const a2 = assistant('the kept reply', u2.uuid)
  const B = { ...(compactMod.createCompactBoundaryMessage('manual', 1000) as Row), parentUuid: null, isSidechain: false, timestamp: tick() }
  const S = { ...(factories.createUserMessage({ content: 'the summary of the folded stretch', isCompactSummary: true }) as Row), parentUuid: B.uuid, isSidechain: false, timestamp: tick() }
  ;(B as { compactMetadata: Record<string, unknown> }).compactMetadata.preservedSegment = { headUuid: u2.uuid, anchorUuid: S.uuid, tailUuid: a2.uuid }
  const u3 = user('words after the fold', S.uuid)
  const a3 = assistant('the reply after the fold', u3.uuid)
  const u4 = user('the words the screen lost', a1.uuid)
  const a4 = assistant('the reply the screen lost', u4.uuid)
  const u5 = user('agreed', a3.uuid)
  const a5 = assistant('the reply to agreed', u5.uuid)
  const name = new Map<string, string>([[u1.uuid, 'u1'], [a1.uuid, 'a1'], [u2.uuid, 'u2'], [a2.uuid, 'a2'], [B.uuid, 'B'], [S.uuid, 'S'], [u3.uuid, 'u3'], [a3.uuid, 'a3'], [u4.uuid, 'u4'], [a4.uuid, 'a4'], [u5.uuid, 'u5'], [a5.uuid, 'a5']])
  const named = (rows: ReadonlyArray<{ uuid: string }>): string[] => rows.map(r => name.get(r.uuid) ?? r.uuid.slice(0, 4))
  write([u1, a1, u2, a2, B, S, u3, a3])
  let chain = await reader.readTranscriptChainSince(path, null)
  check('the compaction folds the head: boundary, summary, the kept tail, the turn after', j(named(chain.rows)) === j(['B', 'S', 'u2', 'a2', 'u3', 'a3']), j(named(chain.rows)))
  write([{ ...u1, parentUuid: a3.uuid }, { ...a1 }, u4, a4])
  chain = await reader.readTranscriptChainSince(path, chain.cursor)
  check('a re-emission of the folded head chained onto the leaf, then a live turn chained onto it: the screen keeps the fold and adds the live turn — the folded rows do not come back', j(named(chain.rows)) === j(['B', 'S', 'u2', 'a2', 'u3', 'a3', 'u4', 'a4']), j(named(chain.rows)))
  write([{ ...u2, parentUuid: a4.uuid }, { ...a2 }, { ...B }, { ...S }, { ...u3 }, { ...a3 }, u5, a5])
  chain = await reader.readTranscriptChainSince(path, chain.cursor)
  check('the boundary and its epoch re-emitted after the live turn, then the next turn chained onto the pre-re-emission leaf: every record of the epoch paints once, in order — the live turn between them stays', j(named(chain.rows)) === j(['B', 'S', 'u2', 'a2', 'u3', 'a3', 'u4', 'a4', 'u5', 'a5']), j(named(chain.rows)))
  const cold = await reader.readTranscriptChainSince(path, null)
  check('a cold read of the same file (a reattach, a resume) paints the same rows', j(named(cold.rows)) === j(named(chain.rows)), j(named(cold.rows)))
  check('the writer\'s dedup set is every record id on disk, pruned by nothing', typeof reader.readTranscriptRecordIds === 'function' && (await reader.readTranscriptRecordIds(path)).size === 13, typeof reader.readTranscriptRecordIds === 'function' ? String((await reader.readTranscriptRecordIds(path)).size) : 'no readTranscriptRecordIds')
  const twice = createdTwice(path)
  check('the synthesized record carries the re-emissions the owner\'s file carries (the shape under test)', twice.length === 8, j(twice.length))
}

type Stamped = Record<string, unknown> & { uuid: string; timestamp: string }
type Seg = { headUuid: string; anchorUuid: string; tailUuid: string }
const loadingMod = await import(join(SRC, 'utils/sessionStorage/loading.ts'))
const chainMod = await import(join(SRC, 'utils/sessionStorage/chain.ts'))
function stampedWorld(label: string) {
  const dir = join(SCRATCH, label)
  mkdirSync(dir, { recursive: true })
  const names = new Map<string, string>()
  const stamp = (iso: string): string => new Date(iso).toISOString()
  const keep = (name: string, row: Stamped): Stamped => {
    names.set(row.uuid, name)
    return row
  }
  const user = (name: string, text: string, parentUuid: string | null, at: string, extra: Record<string, unknown> = {}): Stamped => keep(name, { ...(factories.createUserMessage({ content: text, ...extra }) as Stamped), parentUuid, isSidechain: false, timestamp: stamp(at) })
  const assistant = (name: string, text: string, parentUuid: string | null, at: string): Stamped => keep(name, { ...(factories.createAssistantMessage({ content: [{ type: 'text', text }] }) as Stamped), parentUuid, isSidechain: false, timestamp: stamp(at) })
  const boundary = (name: string, at: string): Stamped => keep(name, { ...(compactMod.createCompactBoundaryMessage('manual', 1000) as Stamped), parentUuid: null, isSidechain: false, timestamp: stamp(at) })
  const summary = (name: string, of: Stamped, at: string): Stamped => user(name, `the summary under ${names.get(of.uuid)}`, of.uuid, at, { isCompactSummary: true })
  const keepTail = (b: Stamped, segment: Seg): void => {
    ;(b as { compactMetadata: { preservedSegment?: Seg } }).compactMetadata.preservedSegment = segment
  }
  const path = join(dir, `${randomUUID()}.jsonl`)
  const write = (rows: Stamped[], settle = false): void => {
    for (const row of rows) appendFileSync(path, (vnext.encodeTranscriptLine(path, row, settle ? { settleCreationOrdinal: '1' } : undefined) as { line: string }).line)
  }
  const named = (rows: ReadonlyArray<{ uuid: string }>): string[] => rows.map(r => names.get(r.uuid) ?? r.uuid.slice(0, 4))
  const screen = async (file = path): Promise<string[]> => {
    reader._resetTranscriptReaderForTesting()
    return named((await reader.readTranscriptChainSince(file, null)).rows)
  }
  const resume = async (file = path): Promise<string[]> => {
    reader._resetTranscriptReaderForTesting()
    const fold = await loadingMod.loadTranscriptFile(file)
    const leaf = chainMod.findLatestMessage(fold.messages.values(), (m: { isSidechain?: boolean }) => !m.isSidechain)
    return leaf === undefined ? [] : named(chainMod.buildConversationChain(fold.messages, leaf))
  }
  return { path, user, assistant, boundary, summary, keepTail, write, named, screen, resume }
}

section('§A2 clocks — the newest compaction is the latest boundary in file order, whatever its stamp says')
{
  const w = stampedWorld('clock-behind')
  const u1 = w.user('u1', 'first words on the first machine', null, '2026-10-20T11:00:00Z')
  const a1 = w.assistant('a1', 'first reply on the first machine', u1.uuid, '2026-10-20T11:01:00Z')
  const B1 = w.boundary('B1', '2026-10-20T11:02:00Z')
  const S1 = w.summary('S1', B1, '2026-10-20T11:02:01Z')
  w.keepTail(B1, { headUuid: u1.uuid, anchorUuid: S1.uuid, tailUuid: a1.uuid })
  const u2 = w.user('u2', 'words after the first fold, first machine', S1.uuid, '2026-10-20T11:03:00Z')
  const a2 = w.assistant('a2', 'reply after the first fold, first machine', u2.uuid, '2026-10-20T11:04:00Z')
  const u3 = w.user('u3', 'words on the second machine, its clock an hour behind', a2.uuid, '2026-10-20T10:10:00Z')
  const a3 = w.assistant('a3', 'reply on the second machine', u3.uuid, '2026-10-20T10:11:00Z')
  const B2 = w.boundary('B2', '2026-10-20T10:15:00Z')
  const S2 = w.summary('S2', B2, '2026-10-20T10:15:01Z')
  w.keepTail(B2, { headUuid: u3.uuid, anchorUuid: S2.uuid, tailUuid: a3.uuid })
  const u4 = w.user('u4', 'the live words after the second fold', S2.uuid, '2026-10-20T10:16:00Z')
  const a4 = w.assistant('a4', 'the live reply after the second fold', u4.uuid, '2026-10-20T10:17:00Z')
  w.write([u1, a1, B1, S1, u2, a2, u3, a3, B2, S2, u4, a4])
  const screen = await w.screen()
  check('a fold written on a machine whose clock runs an hour behind the previous fold\'s: the screen holds that fold, its kept tail and the live turn', j(screen) === j(['B2', 'S2', 'u3', 'a3', 'u4', 'a4']), j(screen))
  const resume = await w.resume()
  check('the same file resumed: the model gets the newest fold\'s chain, never the epoch it folded', j(resume) === j(['B2', 'S2', 'u3', 'a3', 'u4', 'a4']), j(resume))
}
{
  const w = stampedWorld('clock-behind-no-tail')
  const u1 = w.user('u1', 'first words', null, '2026-10-20T11:00:00Z')
  const a1 = w.assistant('a1', 'first reply', u1.uuid, '2026-10-20T11:01:00Z')
  const B1 = w.boundary('B1', '2026-10-20T11:02:00Z')
  const S1 = w.summary('S1', B1, '2026-10-20T11:02:01Z')
  const u2 = w.user('u2', 'words after the first fold', S1.uuid, '2026-10-20T11:03:00Z')
  const a2 = w.assistant('a2', 'reply after the first fold', u2.uuid, '2026-10-20T11:04:00Z')
  const B2 = w.boundary('B2', '2026-10-20T10:15:00Z')
  const S2 = w.summary('S2', B2, '2026-10-20T10:15:01Z')
  const u3 = w.user('u3', 'the live words', S2.uuid, '2026-10-20T10:16:00Z')
  const a3 = w.assistant('a3', 'the live reply', u3.uuid, '2026-10-20T10:17:00Z')
  w.write([u1, a1, B1, S1, u2, a2, B2, S2, u3, a3])
  const screen = await w.screen()
  check('the same move with folds that keep no tail: the screen holds the later fold and the live turn', j(screen) === j(['B2', 'S2', 'u3', 'a3']), j(screen))
}
{
  const w = stampedWorld('clock-tie')
  const u1 = w.user('u1', 'words', null, '2026-10-20T10:00:00Z')
  const a1 = w.assistant('a1', 'reply', u1.uuid, '2026-10-20T10:01:00Z')
  const B1 = w.boundary('B1', '2026-10-20T10:02:00.000Z')
  const S1 = w.summary('S1', B1, '2026-10-20T10:02:00.000Z')
  const B2 = w.boundary('B2', '2026-10-20T10:02:00.000Z')
  const S2 = w.summary('S2', B2, '2026-10-20T10:02:00.000Z')
  w.keepTail(B1, { headUuid: u1.uuid, anchorUuid: S1.uuid, tailUuid: a1.uuid })
  const u2 = w.user('u2', 'the live words', S2.uuid, '2026-10-20T10:03:00Z')
  const a2 = w.assistant('a2', 'the live reply', u2.uuid, '2026-10-20T10:04:00Z')
  w.write([u1, a1, B1, S1, B2, S2, u2, a2])
  const screen = await w.screen()
  check('two folds stamped in the same millisecond: the later one in the file is the newest', j(screen) === j(['B2', 'S2', 'u2', 'a2']), j(screen))
}

section('§A3 the resume snapshot — a record keeps its first position through the snapshot, and a snapshot an older reader wrote is not trusted')
{
  const w = stampedWorld('snapshot-positions')
  const pad = 'x'.repeat(300 * 1024)
  const u1 = w.user('u1', 'first words', null, '2026-10-20T10:00:00Z')
  const a1 = w.assistant('a1', 'first reply', u1.uuid, '2026-10-20T10:01:00Z')
  const B1 = w.boundary('B1', '2026-10-20T10:02:00Z')
  const S1 = w.summary('S1', B1, '2026-10-20T10:02:01Z')
  w.keepTail(B1, { headUuid: u1.uuid, anchorUuid: S1.uuid, tailUuid: a1.uuid })
  const u2 = w.user('u2', 'second words ' + pad, S1.uuid, '2026-10-20T10:03:00Z')
  const a2 = w.assistant('a2', 'second reply', u2.uuid, '2026-10-20T10:04:00Z')
  const u3 = w.user('u3', 'third words', a2.uuid, '2026-10-20T10:05:00Z')
  const a3 = w.assistant('a3', 'third reply', u3.uuid, '2026-10-20T10:06:00Z')
  const B2 = w.boundary('B2', '2026-10-20T10:07:00Z')
  const S2 = w.summary('S2', B2, '2026-10-20T10:07:01Z')
  w.keepTail(B2, { headUuid: u3.uuid, anchorUuid: S2.uuid, tailUuid: a3.uuid })
  const u4 = w.user('u4', 'fourth words', S2.uuid, '2026-10-20T10:08:00Z')
  const a4 = w.assistant('a4', 'fourth reply', u4.uuid, '2026-10-20T10:09:00Z')
  w.write([u1, a1, B1, S1, u2, a2, u3, a3, B2, S2, u4, a4])
  const before = await w.screen()
  check('a cold read before any re-emission wrote the resume snapshot', j(before) === j(['B2', 'S2', 'u3', 'a3', 'u4', 'a4']) && existsSync(`${w.path}.resume-snapshot.json`), j(before))
  w.write([{ ...B1 }, { ...S1 }, { ...u2 }, { ...a2 }])
  const u5 = w.user('u5', 'the words chained onto the re-emitted row', a2.uuid, '2026-10-20T10:10:00Z')
  const a5 = w.assistant('a5', 'the reply after them', u5.uuid, '2026-10-20T10:11:00Z')
  w.write([u5, a5])
  const copy = `${w.path}.no-snapshot.jsonl`
  copyFileSync(w.path, copy)
  const cold = await w.screen(copy)
  check('a cold read of the re-emitted record adopts the live turn the re-emission cut', j(cold) === j(['B2', 'S2', 'u3', 'a3', 'u4', 'a4', 'u5', 'a5']), j(cold))
  const viaSnapshot = await w.screen()
  check('a read through the snapshot written before the re-emission paints exactly the cold read\'s rows', j(viaSnapshot) === j(cold), j(viaSnapshot))
  const resumeVia = await w.resume()
  const resumeCold = await w.resume(copy)
  check('the resume chain through the snapshot is the cold read\'s', j(resumeVia) === j(resumeCold), j({ resumeVia, resumeCold }))
}
{
  const { createHash } = await import('node:crypto')
  const w = stampedWorld('snapshot-old-reader')
  const pad = 'x'.repeat(300 * 1024)
  const u1 = w.user('u1', 'first words ' + pad, null, '2026-10-20T10:00:00Z')
  const a1 = w.assistant('a1', 'first reply', u1.uuid, '2026-10-20T10:01:00Z')
  const u2 = w.user('u2', 'the live words an older reader had dropped', a1.uuid, '2026-10-20T10:02:00Z')
  const a2 = w.assistant('a2', 'the live reply', u2.uuid, '2026-10-20T10:03:00Z')
  w.write([u1, a1, u2, a2])
  const bytes = readFileSync(w.path)
  const cursor = bytes.length
  const kept = entriesOf(w.path).filter(e => e.uuid !== u2.uuid).map(e => [e.uuid, e])
  writeFileSync(`${w.path}.resume-snapshot.json`, JSON.stringify({ schemaVersion: 4, byteCursor: cursor, prefixDigest: createHash('sha256').update(bytes.subarray(Math.max(0, cursor - 4096), cursor)).digest('hex'), fold: { messages: { '«map»': kept } } }))
  const screen = await w.screen()
  check('a snapshot written by the reader before this one (the owner\'s file carries one that lost three live rows) is not trusted: the live words paint', screen.includes('u2'), j(screen))
}

section('§A4 settlement — a settlement re-publication wins over the first copy; a folded row stays folded; a byte-identical re-append changes nothing')
{
  const w = stampedWorld('settlement')
  const u1 = w.user('u1', 'words', null, '2026-10-20T10:00:00Z')
  const a1 = w.assistant('a1', 'the folded reply', u1.uuid, '2026-10-20T10:01:00Z')
  const u2 = w.user('u2', 'the kept words', a1.uuid, '2026-10-20T10:02:00Z')
  const a2 = w.assistant('a2', 'the kept reply', u2.uuid, '2026-10-20T10:03:00Z')
  const B = w.boundary('B', '2026-10-20T10:04:00Z')
  const S = w.summary('S', B, '2026-10-20T10:04:01Z')
  w.keepTail(B, { headUuid: u2.uuid, anchorUuid: S.uuid, tailUuid: a2.uuid })
  const u3 = w.user('u3', 'live words', S.uuid, '2026-10-20T10:05:00Z')
  const a3 = w.assistant('a3', 'live reply, streaming', u3.uuid, '2026-10-20T10:06:00Z')
  w.write([u1, a1, u2, a2, B, S, u3, a3])
  reader._resetTranscriptReaderForTesting()
  const first = await reader.readTranscriptChainSince(w.path, null)
  const settled = (row: Stamped, text: string): Stamped => ({ ...row, message: { ...(row.message as Record<string, unknown>), content: [{ type: 'text', text }] } })
  w.write([settled(a3, 'live reply, settled'), settled(a2, 'the kept reply, settled'), settled(a1, 'the folded reply, settled')], true)
  w.write([{ ...u3 }])
  const next = await reader.readTranscriptChainSince(w.path, first.cursor)
  const bodies = next.rows.map(r => j((r as { message?: unknown }).message ?? ''))
  check('the rows and their order stand after three settlements and a byte-identical re-append', j(w.named(next.rows)) === j(['B', 'S', 'u2', 'a2', 'u3', 'a3']), j(w.named(next.rows)))
  check('the settled live reply paints its settled body, the first copy\'s body is gone', bodies.some(b => b.includes('live reply, settled')) && !bodies.some(b => b.includes('live reply, streaming')))
  check('the settled kept reply paints its settled body', bodies.some(b => b.includes('the kept reply, settled')))
  check('a settlement of a folded row does not bring it back', !bodies.some(b => b.includes('the folded reply')))
  const cold = await w.screen()
  check('a cold read paints the same rows', j(cold) === j(w.named(next.rows)), j(cold))
}

section('§A5 the writer\'s dedup set — the ids this process wrote survive a dropped memo; the incremental scan survives a cut')
{
  const writerMod = await import(join(SRC, 'utils/sessionStorage/writer.ts'))
  const logsMod = await import(join(SRC, 'utils/sessionStorage/logs.ts'))
  const pathsMod = await import(join(SRC, 'utils/sessionStorage/paths.ts'))
  const u1 = factories.createUserMessage({ content: 'the first words, on disk' })
  await writerMod.recordTranscript([u1] as never)
  await writerMod.flushSessionStorage()
  const a1 = factories.createAssistantMessage({ content: [{ type: 'text', text: 'the first reply, still in the write queue' }] })
  const u2 = factories.createUserMessage({ content: 'the second words, still in the write queue' })
  await writerMod.recordTranscript([u1, a1, u2] as never)
  logsMod.clearSessionMessagesCache()
  const u3 = factories.createUserMessage({ content: 'the third words' })
  await writerMod.recordTranscript([u1, a1, u2, u3] as never)
  await writerMod.flushSessionStorage()
  const file = pathsMod.getTranscriptPath() as string
  const twice = createdTwice(file)
  check('the memo dropped while the last rows still sit in the write queue: the whole array recorded again writes nothing twice', twice.length === 0 && entriesOf(file).length === 4, j({ twice: twice.length, rows: entriesOf(file).length }))
}
{
  const dir = join(SCRATCH, 'scan-cut')
  mkdirSync(dir, { recursive: true })
  const path = join(dir, `${randomUUID()}.jsonl`)
  const line = (uuid: string): string => (vnext.encodeTranscriptLine(path, { type: 'user', uuid, parentUuid: null, isSidechain: false, timestamp: new Date().toISOString(), message: { role: 'user', content: 'x'.repeat(200) } }) as { line: string }).line
  for (let i = 0; i < 20; i++) appendFileSync(path, line(`00000000-0000-4000-8000-${String(i).padStart(12, '0')}`))
  reader._resetTranscriptRecordIdScansForTesting()
  await reader.readTranscriptRecordIds(path)
  writeFileSync(path, readFileSync(path, 'utf8').split('\n').filter((_, i) => i !== 5).join('\n'))
  for (let i = 0; i < 6; i++) appendFileSync(path, line(`11111111-0000-4000-8000-${String(i).padStart(12, '0')}`))
  const incremental = await reader.readTranscriptRecordIds(path)
  reader._resetTranscriptRecordIdScansForTesting()
  const whole = await reader.readTranscriptRecordIds(path)
  const missing = [...whole].filter(id => !incremental.has(id))
  check('a line cut from the scanned prefix, then the file grows past the old offset: the incremental scan holds every id a whole-file scan finds', missing.length === 0 && incremental.size === whole.size, j({ missing: missing.length, incremental: incremental.size, whole: whole.size }))
}

section('§A6 the growth read — the first row after the fold lands alone, parented onto the summary: the kept tail stays on the chain (the Linux pool\'s §G red: a screen reading between the summary and the next row lost the whole kept tail)')
{
  const w = stampedWorld('growth-anchor')
  const u1 = w.user('u1', 'the first words, folded', null, '2026-10-20T03:00:01.000Z')
  const a1 = w.assistant('a1', 'the first reply, folded', u1.uuid, '2026-10-20T03:00:02.000Z')
  const u2 = w.user('u2', 'the kept words', a1.uuid, '2026-10-20T03:00:03.000Z')
  const a2 = w.assistant('a2', 'the kept reply', u2.uuid, '2026-10-20T03:00:04.000Z')
  const B = w.boundary('B', '2026-10-20T03:00:05.000Z')
  const S = w.summary('S', B, '2026-10-20T03:00:06.000Z')
  w.keepTail(B, { headUuid: u2.uuid, anchorUuid: S.uuid, tailUuid: a2.uuid })
  const u3 = w.user('u3', 'the first words after the fold', S.uuid, '2026-10-20T03:00:07.000Z')
  const a3 = w.assistant('a3', 'the reply after the fold', u3.uuid, '2026-10-20T03:00:08.000Z')
  const u4 = w.user('u4', 'the next words', a3.uuid, '2026-10-20T03:00:09.000Z')
  const a4 = w.assistant('a4', 'the next reply', u4.uuid, '2026-10-20T03:00:10.000Z')
  reader._resetTranscriptReaderForTesting()
  w.write([u1, a1, u2, a2, B, S])
  let chain = await reader.readTranscriptChainSince(w.path, null)
  check('a read that ends on the summary holds the boundary, the summary and the kept tail', j(w.named(chain.rows)) === j(['B', 'S', 'u2', 'a2']), j(w.named(chain.rows)))
  w.write([u3])
  chain = await reader.readTranscriptChainSince(w.path, chain.cursor)
  check('the first row after the fold, read alone, chains onto the kept tail — the kept tail is not lost to the growth read', j(w.named(chain.rows)) === j(['B', 'S', 'u2', 'a2', 'u3']), j(w.named(chain.rows)))
  w.write([a3, u4, a4])
  chain = await reader.readTranscriptChainSince(w.path, chain.cursor)
  check('the turns that follow stay on the one chain, every row once', j(w.named(chain.rows)) === j(['B', 'S', 'u2', 'a2', 'u3', 'a3', 'u4', 'a4']), j(w.named(chain.rows)))
  check('a cold read of the same file agrees with the grown one', j(await w.screen()) === j(w.named(chain.rows)), j(await w.screen()))
}

if (!existsSync(DIST) || NODE === '') {
  console.log(`\nFAIL ${!existsSync(DIST) ? `dist missing at ${DIST} — run \`bun run build.ts\` first` : 'no node on PATH'}`)
  failures++
  console.log(`\n${checks} checks, ${failures} failures`)
  process.exit(1)
}

const git = (args: string[]): void => {
  const r = spawnSync('git', ['-C', work, '-c', 'user.name=probe', '-c', 'user.email=probe@example.invalid', ...args], { encoding: 'utf8' })
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`)
}
git(['init', '-q'])
writeFileSync(join(work, 'README.md'), 'the screen-replay probe repository\n')
git(['add', 'README.md'])
git(['commit', '-q', '-m', 'the probe commit'])
const { seedFirstRun } = await import('../lib/firstRunSeed.ts')
seedFirstRun(home, [work])

const PACK_NODE = join(dirname(DIST), 'vendor', 'node', 'bin', process.platform === 'win32' ? 'node.exe' : 'node')
const STANDALONE = existsSync(PACK_NODE)
const TREE_X = '111122223333'.padEnd(40, '0')
const TREE_Y = '999988887777'.padEnd(40, '0')
const SHORT_Y = TREE_Y.slice(0, 12)
const mkBuild = (name: string, tree: string, buildTime: string): string => {
  const dir = join(builds, name)
  mkdirSync(join(dir, 'vendor', 'node', 'bin'), { recursive: true })
  copyFileSync(DIST, join(dir, 'mercury.mjs'))
  const manifest = JSON.parse(readFileSync(join(dirname(DIST), 'manifest.json'), 'utf8')) as Record<string, unknown>
  manifest.buildTree = tree
  manifest.buildTime = buildTime
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2))
  if (STANDALONE) {
    const nodeAt = join(dir, 'vendor', 'node', 'bin', 'node')
    try {
      linkSync(PACK_NODE, nodeAt)
    } catch {
      copyFileSync(PACK_NODE, nodeAt)
    }
  }
  return dir
}
mkBuild('X', TREE_X, '2026-01-01T00:00:00.000Z')
mkBuild('Y', TREE_Y, '2026-02-01T00:00:00.000Z')
const pointAt = (name: string, target: string): void => {
  const tmp = join(runtime, `.${name}.new`)
  rmSync(tmp, { force: true })
  symlinkSync(join('builds', target), tmp)
  renameSync(tmp, join(runtime, name))
}
const pointBoth = (target: string): void => {
  pointAt('current', target)
  pointAt('dist', target)
}
pointBoth('X')

const FOLD_MARKER = 'Write the running record of this conversation'
const AUTO_FOLD_PROBE = 'run the probe tool'
;(await import(join(SRC, 'utils/config/globalConfig.ts'))).enableConfigs()
const autoCompactMod = await import(join(SRC, 'services/compact/autoCompact.ts'))
const HEAVY_INPUT_TOKENS = Math.floor((autoCompactMod.getAutoCompactThreshold('claude-sonnet-5') + autoCompactMod.getBlockingLimit('claude-sonnet-5')) / 2)
const sse = (event: string, obj: unknown): string => `event: ${event}\ndata: ${JSON.stringify(obj)}\n\n`
const usage = { input_tokens: 30, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 10 }
type Item = { role?: string; content?: unknown }
const askOf = (content: unknown): string => {
  if (typeof content === 'string') return content.trimStart().startsWith('<system-reminder>') ? '' : content
  if (!Array.isArray(content)) return ''
  for (let i = content.length - 1; i >= 0; i--) {
    const part = content[i] as { type?: string; text?: string }
    if (part.type === 'text' && typeof part.text === 'string' && !part.text.trimStart().startsWith('<system-reminder>')) return part.text
  }
  return ''
}
let calls = 0
const replies: string[] = []
const fixture = createServer((req: IncomingMessage, res: ServerResponse) => {
  const chunks: Buffer[] = []
  req.on('data', c => chunks.push(c as Buffer))
  req.on('end', () => {
    const url = (req.url ?? '').split('?')[0] ?? ''
    if (req.method !== 'POST' || !url.endsWith('/v1/messages')) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{}')
      return
    }
    const raw = Buffer.concat(chunks).toString('utf8')
    let body: Record<string, unknown> = {}
    try {
      body = JSON.parse(raw) as Record<string, unknown>
    } catch {}
    const n = ++calls
    const model = typeof body.model === 'string' ? body.model : 'claude-sonnet-5'
    const items = Array.isArray(body.messages) ? (body.messages as Item[]) : []
    const last = [...items].reverse().find(m => m.role === 'user' && askOf(m.content) !== '')
    const ask = last === undefined ? '' : askOf(last.content)
    const fold = raw.includes(FOLD_MARKER)
    const finalContent = items.at(-1)?.content
    const afterTool = Array.isArray(finalContent) && (finalContent as Array<{ type?: string }>).some(part => part.type === 'tool_result')
    if (!fold && !afterTool && ask.includes(AUTO_FOLD_PROBE)) {
      const heavy = { ...usage, input_tokens: HEAVY_INPUT_TOKENS }
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
      res.end(
        [
          sse('message_start', { type: 'message_start', message: { id: `msg_sr_${n}`, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { ...heavy, output_tokens: 1 } } }),
          sse('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: `toolu_sr_${n}`, name: 'Bash', input: {} } }),
          sse('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify({ command: 'echo the probe tool ran', description: 'Print one line' }) } }),
          sse('content_block_stop', { type: 'content_block_stop', index: 0 }),
          sse('message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: heavy }),
          sse('message_stop', { type: 'message_stop' }),
        ].join(''),
      )
      return
    }
    const text = fold
      ? '<analysis>the walk</analysis><summary>1. Operator Intent: the operator kept talking. 2. Technical Ground: none. 3. Files and Code Touched: none. 4. Errors and Corrections: none. 5. Problems Worked: none. 6. Operator Messages: the words so far. 7. Open Work: none. 8. Where Work Stands: idle. 9. Next Move (optional): none. 10. Agents in flight: none.</summary>'
      : `heard ${ask.trim().split('\n').pop()} (#${n})${ask.trim().split('\n').pop()?.startsWith('carry ') || ask.trim().split('\n').pop() === WORDS[0] ? ` ${Array.from({ length: 400 }, (_, k) => `fact ${n}-${k} of the carried log reads ${(k * 7919 + n * 104729).toString(36)}.`).join(' ')}` : ''}`
    if (!fold) replies.push(text)
    const measured = { ...usage, input_tokens: Math.ceil(raw.length / 4), output_tokens: Math.ceil(text.length / 4) }
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
    res.end(
      [
        sse('message_start', { type: 'message_start', message: { id: `msg_sr_${n}`, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { ...measured, output_tokens: 1 } } }),
        sse('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
        sse('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }),
        sse('content_block_stop', { type: 'content_block_stop', index: 0 }),
        sse('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: measured }),
        sse('message_stop', { type: 'message_stop' }),
      ].join(''),
    )
  })
})
await new Promise<void>(resolve => fixture.listen(0, '127.0.0.1', resolve))
const base = `http://127.0.0.1:${(fixture.address() as { port: number }).port}`

const daemonEnv: NodeJS.ProcessEnv = {
  ...process.env,
  HOME: home,
  MERCURY_CONFIG_DIR: home,
  MERCURY_DAEMON_DIR: daemonDir,
  MERCURY_CREDENTIAL_STORE: 'file',
  MERCURY_DAEMON_PERMISSION_MODE: 'sovereign',
  MERCURY_OPERATOR: 'sam',
  ANTHROPIC_API_KEY: 'fixture-key-000',
  ANTHROPIC_BASE_URL: base,
  OPENAI_API_KEY: '',
  MERCURY_CACHE_CLOCK: '0',
  MERCURY_PARTY: '0',
  MERCURY_LOCAL_PROBE_TARGETS: 'none',
  MERCURY_TERMINAL_TITLE: '0',
  MERCURY_TURN_RECEIPT: '0',
  MERCURY_VERIFY_EVIDENCE: '0',
  MERCURY_WARM_RUNNER: '0',
  MERCURY_COMPACT_KEEP_TAIL: '1',
}
for (const [k, v] of Object.entries(daemonEnv)) {
  if (v === undefined) delete process.env[k]
  else process.env[k] = v
}
process.env.MERCURY_DAEMON_OWNER_PID = String(process.pid)
process.execPath = NODE
process.chdir(work)

const { daemonControlRpc } = await import(join(SRC, 'daemon/controlSocket.ts'))
const paths = await import(join(SRC, 'utils/sessionStorage/paths.ts'))
const { isProcessAlive } = await import(join(SRC, 'daemon/ownerWatch.ts'))
const { restartSessionOnInstalledBuild } = await import(join(SRC, 'commands/restart/restart.ts'))
const connectorModule = await import(join(SRC, 'services/engine-connector/daemonConnector.ts'))
const { DaemonSessionConnector } = connectorModule as { DaemonSessionConnector: new (record: Record<string, unknown>) => { attach(): Promise<void>; detach(): void; records(): ReadonlyArray<{ uuid: string; type?: string; message?: { content?: unknown } }>; transcriptFile(): string } }

const read = (p: string): string => {
  try {
    return readFileSync(p, 'utf8')
  } catch {
    return ''
  }
}
type Rec = { runnerId: string; sessionId: string; pid?: number; title?: string }
const records = (): Rec[] => {
  try {
    return Object.values((JSON.parse(read(join(daemonDir, 'concourse-workers.json'))) as { workers: Record<string, Rec> }).workers)
  } catch {
    return []
  }
}
const recOf = (sid: string): Rec | undefined => records().find(w => w.sessionId === sid)
const projectDir = paths.getProjectDir(work) as string
const transcriptPathOf = (sid: string): string => join(projectDir, `${sid}.jsonl`)
const facts = (sid: string): { busy?: boolean } | undefined => {
  try {
    return JSON.parse(read(join(daemonDir, 'session-facts', `${sid}.json`))) as { busy?: boolean }
  } catch {
    return undefined
  }
}
const pidsInWorld = (also: (line: string) => boolean = () => true): number[] =>
  (spawnSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8' }).stdout ?? '')
    .split('\n')
    .filter(l => l.includes(SCRATCH) && also(l))
    .map(l => Number(l.trim().split(/\s+/)[0]))
    .filter(n => Number.isInteger(n) && n > 0 && n !== process.pid)
const daemonPids = (): number[] => pidsInWorld(l => l.includes(' daemon run '))
const spawnDaemon = (log: string): ChildProcess =>
  spawn(NODE, [join(runtime, 'current', 'mercury.mjs'), 'daemon', 'run', work], {
    cwd: work,
    env: { ...daemonEnv, MERCURY_DAEMON_OWNER_PID: String(process.pid) },
    stdio: ['ignore', openSync(log, 'a'), openSync(log, 'a')],
  })
const hello = async (): Promise<{ pid: number } | null> => {
  const { MERCURY_DAEMON_PROTO } = await import(join(SRC, 'daemon/protocol.ts'))
  const reply = (await daemonControlRpc({ op: 'hello', proto: MERCURY_DAEMON_PROTO, clientVersion: '1.0.0', clientBuildTree: null } as never, { timeoutMs: 2000, protoRetry: false })) as { ok?: boolean; op?: string; pid?: number }
  return reply.ok === true && reply.op === 'hello' && typeof reply.pid === 'number' ? { pid: reply.pid } : null
}
const dispatch = async (prompt: string, extra: Record<string, unknown> = {}): Promise<{ ok?: boolean; sessionId?: string; error?: string }> =>
  (await daemonControlRpc(
    { op: 'concourseDispatch', clientMessageId: randomUUID(), prompt, workspaceDir: work, title: 'Screen replay probe', model: 'claude-sonnet-5', effort: 'high', permissionMode: 'sovereign', by: 'operator', sentAt: new Date().toISOString(), ...extra } as never,
    { timeoutMs: 30_000 },
  )) as { ok?: boolean; sessionId?: string; error?: string }
const resumeAsTheScreenDoes = async (sid: string, restartReason?: string): Promise<string | null> => {
  const reply = (await daemonControlRpc(
    { op: 'sessionAdmit', workspaceDir: work, resumeSessionId: sid, isolation: 'shared', by: 'operator', ...(restartReason !== undefined ? { restartReason } : {}) } as never,
    { timeoutMs: 60_000 },
  )) as { ok?: boolean; error?: string }
  return reply.ok === true ? null : (reply.error ?? 'the daemon refused the resume')
}

const logA = join(SCRATCH, 'daemon-A.log')
const A = spawnDaemon(logA)
const Apid = A.pid ?? 0
const screens: Array<{ detach(): void }> = []
const cleanup = async (): Promise<void> => {
  for (const s of screens) {
    try {
      s.detach()
    } catch {}
  }
  try {
    await daemonControlRpc({ op: 'shutdown', reapWorkers: true } as never, { timeoutMs: 3000 })
  } catch {}
  await sleep(800)
  for (const pid of [...daemonPids(), ...pidsInWorld()]) {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {}
  }
  await new Promise<void>(resolve => fixture.close(() => resolve()))
  if (!KEEP && failures === 0) removeScratch(SCRATCH)
  else console.log(`[forensics] world kept: ${SCRATCH}`)
}

const WORDS = ['the first words of the session', 'the second words', 'the third words', 'the fourth words, after the first fold', 'the fifth words', 'the sixth words', 'the seventh words, after the second fold', 'the eighth words']

try {
  section('§B folds 46ag and 46ao: measured shrinkable turns let the runner compact twice while the screen reads through its real connector')
  check('daemon A came up', await untilAsync(async () => (await hello())?.pid === Apid, 45_000), read(logA).slice(-600))
  const born = await dispatch(WORDS[0]!)
  const sid = born.sessionId ?? ''
  check('the session was born on the daemon by the operator', born.ok === true && sid !== '', j(born))
  const transcript = transcriptPathOf(sid)
  const replyLanded = (words: string): boolean => read(transcript).includes(`heard ${words}`) && facts(sid)?.busy === false
  check('the first turn settled', await untilAsync(() => replyLanded(WORDS[0]!), 60_000), read(transcript).slice(-300))
  const screenRecord = { sessionId: sid, runnerId: recOf(sid)?.runnerId ?? 'runner', title: 'Screen replay probe', projectLabel: 'work', workspaceId: work, home: projectDir, modelKey: 'claude-sonnet-5' }
  const screen = new DaemonSessionConnector(screenRecord)
  screens.push(screen)
  await screen.attach()
  check('the screen attached to the session\'s own transcript', screen.transcriptFile() === transcript && screen.records().length > 0, j({ file: screen.transcriptFile(), rows: screen.records().length }))
  const say = async (words: string): Promise<void> => {
    const sent = await dispatch(words, { targetSessionId: sid })
    check(`sent: ${words}`, sent.ok === true, j(sent))
    check(`answered: ${words}`, await untilAsync(() => replyLanded(words), 60_000), read(transcript).slice(-300))
  }
  await say(WORDS[1]!)
  await say(WORDS[2]!)
  const boundariesOnDisk = (): number => recordLines(transcript).filter(r => (r.payload as { kind?: string; boundaryKind?: string } | undefined)?.kind === 'boundary').length
  const compact = async (label: string, expected: number): Promise<void> => {
    const sent = await dispatch('/compact', { targetSessionId: sid })
    check(`${label}: /compact dispatched`, sent.ok === true, j(sent))
    check(`${label}: the fold landed (a compaction boundary record on disk)`, await untilAsync(() => boundariesOnDisk() >= expected && facts(sid)?.busy === false, 90_000), j({ boundaries: boundariesOnDisk(), busy: facts(sid)?.busy }))
  }
  await compact('the first fold', 1)
  await say(WORDS[3]!)
  await say(WORDS[4]!)
  await say(WORDS[5]!)
  for (let step = 1; step <= 12; step++) await say(`carry step ${step}`)
  await compact('the second fold', 2)
  await say(WORDS[6]!)
  await say(WORDS[7]!)
  const recordQuiet = async (): Promise<void> => {
    let last = -1
    let stableSince = Date.now()
    await untilAsync(() => {
      const size = statSync(transcript).size
      if (size !== last) {
        last = size
        stableSince = Date.now()
      }
      return Date.now() - stableSince >= 1200
    }, 20_000, 100)
  }
  const screenSettled = async (s: { records(): ReadonlyArray<{ uuid: string }> }): Promise<void> => {
    await recordQuiet()
    await untilAsync(() => {
      const want = epochOf(entriesOf(transcript))
      return want !== null && [...want.all].every(id => s.records().some(r => r.uuid === id)) && s.records().every(r => want.all.has(r.uuid))
    }, 15_000)
  }

  section('§C the record: a row already on disk is never appended again')
  const twice = createdTwice(transcript)
  check('no record of the session was created twice (the re-emission the owner\'s file carries does not happen)', twice.length === 0, `${twice.length} record(s) created twice, e.g. ${j(twice.slice(0, 3))}`)
  const chainEntries = entriesOf(transcript)
  check('the record holds the two compactions and every turn', boundariesOnDisk() === 2 && WORDS.every(w => chainEntries.some(e => textOf(e as never).includes(w))), j({ boundaries: boundariesOnDisk(), rows: chainEntries.length }))

  section('§D the screen that stayed attached through both folds, and a screen attaching now')
  const afterSecondFold = WORDS.slice(6)
  const repliesAfter = replies.filter(r => afterSecondFold.some(w => r.includes(w)))
  await screenSettled(screen)
  judgeScreen('the attached screen', screen.records(), transcript, [...afterSecondFold, ...repliesAfter])
  const fresh = new DaemonSessionConnector(screenRecord)
  screens.push(fresh)
  await fresh.attach()
  await screenSettled(fresh)
  judgeScreen('a screen attaching now', fresh.records(), transcript, [...afterSecondFold, ...repliesAfter])
  check('both screens paint the same rows', j(screen.records().map(r => r.uuid)) === j(fresh.records().map(r => r.uuid)))
  fresh.detach()

  section('§E /restart: the session stops and resumes on the installed build; the screen shows the rows from before and after the compaction, once each')
  pointBoth('Y')
  const pidBefore = recOf(sid)?.pid ?? 0
  const restarted = await restartSessionOnInstalledBuild({ sessionId: sid, turnActive: facts(sid)?.busy === true, work: [], tell: () => {}, resume: (s: string) => resumeAsTheScreenDoes(s, 'update') })
  check('/restart moved the session onto the installed build', restarted.ok === true && restarted.line.includes(`Restarted on the installed build (${SHORT_Y})`), j(restarted))
  const pidAfter = recOf(sid)?.pid ?? 0
  check('a new runner stands behind the session', pidAfter !== 0 && pidAfter !== pidBefore && isProcessAlive(pidAfter), j({ pidBefore, pidAfter }))
  await say(WORDS[7]! + ' again, after the restart')
  await screenSettled(screen)
  const afterRestartWords = [...afterSecondFold, WORDS[7]! + ' again, after the restart']
  judgeScreen('the attached screen after /restart', screen.records(), transcript, afterRestartWords)
  const afterRestart = new DaemonSessionConnector({ ...screenRecord, runnerId: recOf(sid)?.runnerId ?? 'runner' })
  screens.push(afterRestart)
  await afterRestart.attach()
  await screenSettled(afterRestart)
  judgeScreen('a screen attaching after /restart', afterRestart.records(), transcript, afterRestartWords)
  afterRestart.detach()
  check('still no record created twice after the restart', createdTwice(transcript).length === 0, j(createdTwice(transcript).slice(0, 3)))

  section('§F the daemon restarts: the session is resumed by a new daemon; the screen shows every row once')
  const Bpid = (await hello())?.pid ?? 0
  const runnerPid = recOf(sid)?.pid ?? 0
  for (const pid of [Bpid, runnerPid]) {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {}
  }
  check('the daemon and the runner are gone', await untilAsync(() => !isProcessAlive(Bpid) && !isProcessAlive(runnerPid), 15_000))
  const logC = join(SCRATCH, 'daemon-C.log')
  const C = spawnDaemon(logC)
  const Cpid = C.pid ?? 0
  check('daemon C came up', await untilAsync(async () => (await hello())?.pid === Cpid, 45_000), read(logC).slice(-600))
  const resumed = await resumeAsTheScreenDoes(sid)
  check('the session resumed on daemon C', resumed === null, String(resumed))
  await say('the ninth words, after the daemon restart')
  const finalWords = [...afterRestartWords, 'the ninth words, after the daemon restart']
  await screenSettled(screen)
  judgeScreen('the attached screen after the daemon restart', screen.records(), transcript, finalWords)
  const afterDaemon = new DaemonSessionConnector({ ...screenRecord, runnerId: recOf(sid)?.runnerId ?? 'runner' })
  screens.push(afterDaemon)
  await afterDaemon.attach()
  await screenSettled(afterDaemon)
  judgeScreen('a screen attaching after the daemon restart', afterDaemon.records(), transcript, finalWords)
  afterDaemon.detach()
  check('no record created twice across the whole scenario', createdTwice(transcript).length === 0, j(createdTwice(transcript).slice(0, 3)))

  section('§G an automatic fold in the middle of a turn: the dedup memo drops while the turn\'s own rows are in flight, then the runner records its whole array through it')
  const foldsBefore = boundariesOnDisk()
  const probeSent = await dispatch(`the tenth words: ${AUTO_FOLD_PROBE}`, { targetSessionId: sid })
  check('sent: a turn whose first reply calls a tool with the window nearly full', probeSent.ok === true, j(probeSent))
  check('an automatic fold landed mid-turn and the turn settled', await untilAsync(() => boundariesOnDisk() > foldsBefore && facts(sid)?.busy === false && read(transcript).includes('the probe tool ran'), 90_000), j({ boundaries: boundariesOnDisk(), before: foldsBefore, busy: facts(sid)?.busy }))
  check('no record created twice after the mid-turn fold', createdTwice(transcript).length === 0, j(createdTwice(transcript).slice(0, 3)))
  await screenSettled(screen)
  judgeScreen('the attached screen after the mid-turn fold', screen.records(), transcript, [])
} finally {
  await cleanup()
}

console.log(`\n${checks} checks, ${failures} failures`)
console.log(failures === 0 ? '✅ prove-screen-replay-after-compact: ALL PASS' : `❌ prove-screen-replay-after-compact: ${failures} FAIL`)
clearTimeout(guard)
process.exit(failures === 0 ? 0 : 1)
