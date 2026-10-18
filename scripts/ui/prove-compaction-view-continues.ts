#!/usr/bin/env bun
import { appendFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const HOME = mkdtempSync(join(tmpdir(), 'compaction-view-home-'))
process.env.MERCURY_CONFIG_DIR = HOME
process.env.NODE_ENV = 'test'

let failures = 0
let checks = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  checks++
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail.slice(0, 700)}` : ''}`)
}
const section = (title: string): void => console.log(`\n${'─'.repeat(76)}\n${title}`)
const j = (value: unknown): string => JSON.stringify(value)

const { computeSliceStart } = await import('../../src/components/Messages.js')
const { encodeTranscriptLine } = await import('../../src/utils/sessionStorage/vnext.ts')
const reader = await import('../../src/utils/sessionStorage/transcriptReader.ts')

type Row = { uuid: string; type: string; subtype?: string }
type Anchor = { current: { uuid: string; idx: number; folds?: number } | null }
const u = (tag: string, n: number): string => `${tag}${String(n).padStart(8 - tag.length, '0')}-0000-4000-8000-000000000000`.slice(0, 36)
const turn = (tag: string, n: number): Row => ({ uuid: u(tag, n), type: n % 2 === 0 ? 'user' : 'assistant' })
const fold = (n: number): Row => ({ uuid: u('fold', n), type: 'system', subtype: 'compact_boundary' })
const slice = (rows: Row[], anchor: Anchor, cap = 200, step = 50): number => computeSliceStart(rows as never, anchor as never, cap, step)
const painted = (rows: Row[], anchor: Anchor, cap = 200, step = 50): Row[] => rows.slice(slice(rows, anchor, cap, step))

section('§1 the slice after a compaction: the view restarts at the fold boundary and paints the kept tail and every later turn')
{
  const before = Array.from({ length: 1200 }, (_, n) => turn('b', n))
  const anchor: Anchor = { current: null }
  const startBefore = slice(before, anchor)
  check('fixture: a long conversation is capped to its last 200 rows, the anchor deep in the list', startBefore === 1000 && anchor.current?.idx === 1000 && anchor.current.uuid === u('b', 1000), j(anchor.current))
  const kept = before.slice(1160)
  const later = Array.from({ length: 160 }, (_, n) => turn('a', n))
  const summary: Row = { uuid: u('summary', 1), type: 'user' }
  const after = [fold(1), summary, ...kept, ...later]
  const shown = painted(after, anchor)
  check('after the fold the view starts at the boundary row', shown[0]?.uuid === u('fold', 1), j({ start: after.length - shown.length, first: shown[0] }))
  check('…and paints the kept tail and every later turn exactly as the record has them', j(shown.map(row => row.uuid)) === j(after.map(row => row.uuid)), `${shown.length} of ${after.length}`)
  check('the anchor now names the boundary and remembers one fold', anchor.current?.uuid === u('fold', 1) && anchor.current.idx === 0 && anchor.current.folds === 1, j(anchor.current))
  const next = [...after, turn('a', 160), turn('a', 161)]
  check('the next paints keep the start at the boundary (no repaint of the whole terminal per turn)', slice(next, anchor) === 0 && painted(next, anchor).length === next.length)
}

section('§2 refusals: the older laws of the slice hold when no new fold landed')
{
  const rows = Array.from({ length: 1200 }, (_, n) => turn('c', n))
  const anchor: Anchor = { current: null }
  slice(rows, anchor)
  const regrouped = rows.map(row => (row.uuid === u('c', 1000) ? { ...row, uuid: u('r', 1000) } : row))
  check('a collapse regrouping that renames the anchor row falls back to the stored index as before (no fold landed)', slice(regrouped, anchor) === 1000)
  const withOldFold = [fold(9), ...rows]
  const anchored: Anchor = { current: null }
  slice(withOldFold, anchored)
  const startWithOld = slice(withOldFold, anchored)
  check('a boundary that was already in the list when the anchor was set does not restart the view', startWithOld === 1001 && anchored.current?.folds === 1, j({ startWithOld, anchor: anchored.current }))
  const renamedUnderOldFold = withOldFold.map(row => (row.uuid === u('c', 1000) ? { ...row, uuid: u('r', 1000) } : row))
  check('…nor does a regrouping under an old boundary (the stored index still rules)', slice(renamedUnderOldFold, anchored) === 1001)
  const legacyAnchor: Anchor = { current: { uuid: 'gone', idx: 1000 } }
  const shrunk = [fold(2), ...rows.slice(1160)]
  check('an anchor without a fold count (an older reading) keeps the clamped fallback, never a guess', slice(shrunk, legacyAnchor) === shrunk.length - 1)
  const twice: Anchor = { current: null }
  slice(rows, twice)
  const secondFold = [fold(3), ...rows.slice(1100, 1200), ...Array.from({ length: 30 }, (_, n) => turn('d', n)), fold(4), ...Array.from({ length: 20 }, (_, n) => turn('e', n))]
  const startTwice = slice(secondFold, twice)
  check('two folds since the anchor: the view restarts at the NEWEST boundary', secondFold[startTwice]?.uuid === u('fold', 4), j({ startTwice, row: secondFold[startTwice] }))
  const wide: Anchor = { current: null }
  slice(rows, wide)
  const bigAfter = [fold(5), ...rows.slice(1100), ...Array.from({ length: 400 }, (_, n) => turn('f', n))]
  check('the render cap still rules a fold whose rows after the boundary exceed cap + step', slice(bigAfter, wide) === bigAfter.length - 200)
  const empty: Anchor = { current: { uuid: 'x', idx: 3, folds: 0 } }
  check('an empty list answers 0 and clears the anchor', slice([], empty) === 0 && empty.current === null)
}

section('§3 the record: a transcript with a boundary mid-way — the chain the view reads, sliced as the screen slices it')
{
  const dir = mkdtempSync(join(tmpdir(), 'compaction-view-record-'))
  const sid = '0f0f0f0f-0000-4000-8000-00000000000f'
  const file = join(dir, `${sid}.jsonl`)
  const stamp = (n: number): string => new Date(1_760_000_000_000 + n * 1000).toISOString()
  const line = (entry: Record<string, unknown>): string => encodeTranscriptLine(file, entry).line
  const write = (entry: Record<string, unknown>): void => appendFileSync(file, line(entry))
  const user = (n: number, parent: string | null, text: string, extra: Record<string, unknown> = {}): Record<string, unknown> =>
    ({ type: 'user', uuid: u('t', n), parentUuid: parent, isSidechain: false, sessionId: sid, timestamp: stamp(n), cwd: dir, version: 'proof', message: { role: 'user', content: text }, ...extra })
  const assistant = (n: number, parent: string | null, text: string): Record<string, unknown> =>
    ({ type: 'assistant', uuid: u('t', n), parentUuid: parent, isSidechain: false, sessionId: sid, timestamp: stamp(n), cwd: dir, version: 'proof', requestId: `req_${n}`, message: { id: `msg_${n}`, role: 'assistant', model: 'fixture', content: [{ type: 'text', text }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } })
  const TOTAL = 60
  for (let n = 0; n < TOTAL; n++) write(n % 2 === 0 ? user(n, n === 0 ? null : u('t', n - 1), `question ${n}`) : assistant(n, u('t', n - 1), `answer ${n}`))
  const firstRead = await reader.readTranscriptChainSince(file, null)
  const rowsBefore = firstRead.rows as unknown as Row[]
  const anchor: Anchor = { current: null }
  const startBefore = slice(rowsBefore, anchor, 20, 5)
  check('fixture: before the fold the view shows the last 20 of 60 rows', rowsBefore.length === TOTAL && startBefore === 40, j({ rows: rowsBefore.length, startBefore }))
  const KEPT_FROM = 52
  const boundaryUuid = u('fold', 7)
  const summaryUuid = u('summary', 7)
  write({ type: 'system', subtype: 'compact_boundary', uuid: boundaryUuid, parentUuid: null, logicalParentUuid: u('t', TOTAL - 1), isSidechain: false, sessionId: sid, timestamp: stamp(TOTAL), cwd: dir, version: 'proof', level: 'info', content: 'Conversation compacted', compactMetadata: { trigger: 'manual', preTokens: 1000, postTokens: 100, preservedSegment: { headUuid: u('t', KEPT_FROM), anchorUuid: summaryUuid, tailUuid: u('t', TOTAL - 1) } } })
  write(user(TOTAL + 1, boundaryUuid, 'the summary of everything before', { uuid: summaryUuid, isCompactSummary: true }))
  for (let n = TOTAL + 2; n < TOTAL + 12; n++) write(n % 2 === 0 ? user(n, n === TOTAL + 2 ? u('t', TOTAL - 1) : u('t', n - 1), `later question ${n}`) : assistant(n, u('t', n - 1), `later answer ${n}`))
  const secondRead = await reader.readTranscriptChainSince(file, firstRead.cursor)
  const rowsAfter = secondRead.rows as unknown as Row[]
  const boundaryAt = rowsAfter.findIndex(row => row.uuid === boundaryUuid)
  check('the chain the view reads begins at the boundary and carries the kept tail and the later turns', boundaryAt === 0 && rowsAfter.some(row => row.uuid === u('t', KEPT_FROM)) && rowsAfter.some(row => row.uuid === u('t', TOTAL + 11)), j(rowsAfter.map(row => row.uuid.slice(0, 8))))
  const shown = painted(rowsAfter, anchor, 20, 5)
  check('the screen paints every row after the boundary: the summary, the kept tail and the later turns, nothing skipped', j(shown.map(row => row.uuid)) === j(rowsAfter.map(row => row.uuid)), j({ shown: shown.length, chain: rowsAfter.length, first: shown[0]?.uuid.slice(0, 8) }))
  check('…the kept-verbatim tail is among them', shown.some(row => row.uuid === u('t', KEPT_FROM)) && shown.some(row => row.uuid === u('t', TOTAL - 1)))
  check('…and the last later turn too', shown[shown.length - 1]?.uuid === u('t', TOTAL + 11))
  rmSync(dir, { recursive: true, force: true })
}

rmSync(HOME, { recursive: true, force: true })
console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures > 0) {
  console.log(`${failures} check(s) failed`)
  process.exit(1)
}
console.log('all checks passed')
