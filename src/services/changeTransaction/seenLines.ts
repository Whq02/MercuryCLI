
import { createHash } from 'node:crypto'
import { closeSync, readSync, statSync, type Stats } from 'node:fs'
import { openRegularFileSync } from '../../utils/regularFile.js'
import { ideFileGeneration } from '../acp/ideToolBridge.js'
import { remoteGeneration } from '../remoteFiles/target.js'
import { runtimeKernel } from '../primitives/runtimeKernel.js'
import { registerOwnerScopedStore } from '../run/ownerLifecycle.js'
import { parseOwnerKey, type OwnerKey } from '../run/ownerKey.js'
import { OwnerScopedStore } from '../run/ownerScopedStore.js'
import type { HunkSpan } from './hunks.js'

export const SEEN_LINES_BOUNDS = {
  rangeCap: 256,
  fileCap: 512,
  fileBytes: 1024 * 1024 * 1024,
} as const

type SeenRange = { start: number; end: number }

export type ColumnCut = { line: number; visibleChars: number }

interface FileLedger {
  generation: string
  cuts?: ColumnCut[]
  ranges: SeenRange[]
}

interface LedgerState {
  files: Map<string, FileLedger>
}

const store = new OwnerScopedStore<LedgerState>({
  name: 'seen-lines',
  create: () => ({ files: new Map() }),
  cap: 32,
})
registerOwnerScopedStore(store)

function generationOf(st: { mtimeMs: number; size: number }): string {
  return `m${Math.floor(st.mtimeMs)}:${st.size}`
}

function contentDigestOf(bytes: Uint8Array): string {
  return runtimeKernel().hash.sha256Hex(bytes).slice(0, 12)
}

const UNSIZED_READ_CHUNK = 64 * 1024

function readOpenFile(fd: number, size: number): Buffer | null {
  if (size > 0) {
    const bytes = Buffer.allocUnsafe(size)
    let filled = 0
    while (filled < size) {
      const got = readSync(fd, bytes, filled, size - filled, null)
      if (got === 0) break
      filled += got
    }
    return bytes.subarray(0, filled)
  }
  const chunks: Buffer[] = []
  let total = 0
  for (;;) {
    const chunk = Buffer.allocUnsafe(UNSIZED_READ_CHUNK)
    const got = readSync(fd, chunk, 0, chunk.length, null)
    if (got === 0) return Buffer.concat(chunks, total)
    total += got
    if (total > SEEN_LINES_BOUNDS.fileBytes) return null
    chunks.push(chunk.subarray(0, got))
  }
}

function isRegularFileWithinBound(st: { isFile(): boolean; size: number }): boolean {
  return st.isFile() && st.size <= SEEN_LINES_BOUNDS.fileBytes
}

const DIGEST_CHUNK = 1024 * 1024

type LineFound = { text: string; whole: boolean }
type Wanted = { lines: Map<number, number>; wholeUpTo: number }
type Scan = { digest: string; lines: Map<number, LineFound>; whole: Buffer | null }

function scanOpenFile(fd: number, size: number, wanted?: Wanted): Scan | null {
  const hash = createHash('sha256')
  const chunk = Buffer.allocUnsafe(size > 0 ? Math.min(size, DIGEST_CHUNK) : UNSIZED_READ_CHUNK)
  const lines = new Map<number, LineFound>()
  let whole: Buffer[] | null = wanted === undefined ? null : []
  let total = 0
  let lineNumber = 1
  let keep = wanted?.lines.get(1)
  let held: Buffer[] = []
  let heldBytes = 0
  let lineBytes = 0
  const settleLine = (): void => {
    if (keep !== undefined) lines.set(lineNumber, { text: Buffer.concat(held, heldBytes).toString('utf8'), whole: lineBytes === heldBytes })
    lineNumber++
    keep = wanted?.lines.get(lineNumber)
    held = []
    heldBytes = 0
    lineBytes = 0
  }
  for (;;) {
    const want = size > 0 ? Math.min(chunk.length, size - total) : chunk.length
    const got = want === 0 ? 0 : readSync(fd, chunk, 0, want, null)
    if (got === 0) break
    total += got
    if (total > SEEN_LINES_BOUNDS.fileBytes) return null
    const piece = chunk.subarray(0, got)
    hash.update(piece)
    if (wanted === undefined) continue
    if (whole !== null) {
      if (total > wanted.wholeUpTo) whole = null
      else whole.push(Buffer.from(piece))
    }
    let from = 0
    for (;;) {
      const newline = piece.indexOf(10, from)
      const end = newline === -1 ? got : newline
      if (keep !== undefined && heldBytes < keep && end > from) {
        const take = Math.min(end - from, keep - heldBytes)
        held.push(Buffer.from(piece.subarray(from, from + take)))
        heldBytes += take
      }
      lineBytes += end - from
      if (newline === -1) break
      settleLine()
      from = newline + 1
    }
  }
  if (wanted !== undefined) settleLine()
  return { digest: hash.digest('hex').slice(0, 12), lines, whole: whole === null ? null : Buffer.concat(whole, total) }
}

function withRegularFile<Read>(path: string, read: (fd: number, stats: Stats) => Read | null): Read | null {
  try {
    const early = statSync(path)
    if (!isRegularFileWithinBound(early)) return null
    const { fd, stats } = openRegularFileSync(path, early)
    try {
      return isRegularFileWithinBound(stats) ? read(fd, stats) : null
    } finally {
      closeSync(fd)
    }
  } catch {
    return null
  }
}

function readRegularFile(path: string, onlyOfSize: number): { generation: string; bytes: Buffer } | null {
  return withRegularFile(path, (fd, stats) => {
    if (stats.size !== onlyOfSize) return null
    const bytes = readOpenFile(fd, stats.size)
    return bytes === null ? null : { generation: `${generationOf(stats)}:${contentDigestOf(bytes)}`, bytes }
  })
}

function scanRegularFile(path: string, wanted?: Wanted): ({ generation: string } & Scan) | null {
  return withRegularFile(path, (fd, stats) => {
    const scan = scanOpenFile(fd, stats.size, wanted)
    return scan === null ? null : { generation: `${generationOf(stats)}:${scan.digest}`, ...scan }
  })
}

export function fileGeneration(path: string): string | null {
  const remote = remoteGeneration(path)
  if (remote !== undefined) return remote
  const ideGen = ideFileGeneration(path)
  if (ideGen !== null) return ideGen
  return scanRegularFile(path)?.generation ?? null
}

function coalesce(ranges: SeenRange[]): SeenRange[] {
  if (ranges.length <= 1) return ranges
  const sorted = [...ranges].sort((a, b) => a.start - b.start || a.end - b.end)
  const out: SeenRange[] = [sorted[0]!]
  for (let i = 1; i < sorted.length; i++) {
    const cur = sorted[i]!
    const last = out[out.length - 1]!
    if (cur.start <= last.end + 1) {
      if (cur.end > last.end) last.end = cur.end
    } else {
      out.push({ ...cur })
    }
  }
  return out
}

function ledgerFor(owner: OwnerKey, path: string): Map<string, FileLedger> {
  const state = store.get(owner)
  return state.files
}

const SESSION_WRITES_CAP = 32
const sessionWrites = new Map<string, Map<string, FileLedger>>()

function sessionOf(owner: OwnerKey): string {
  try {
    const id = parseOwnerKey(owner)
    return `${id.workspace}|${id.sessionId}`
  } catch {
    return owner
  }
}

function recordSessionWrite(owner: OwnerKey, path: string, generation: string, ranges: SeenRange[]): void {
  if (ranges.length === 0) return
  const key = sessionOf(owner)
  let files = sessionWrites.get(key)
  if (files === undefined) {
    files = new Map()
    sessionWrites.set(key, files)
    while (sessionWrites.size > SESSION_WRITES_CAP) {
      const oldest = sessionWrites.keys().next().value as string | undefined
      if (oldest === undefined) break
      sessionWrites.delete(oldest)
    }
  }
  const entry = files.get(path)
  const kept = entry !== undefined && entry.generation === generation ? entry.ranges : []
  files.delete(path)
  files.set(path, { generation, ranges: coalesce([...kept, ...ranges]).slice(0, SEEN_LINES_BOUNDS.rangeCap) })
  while (files.size > SEEN_LINES_BOUNDS.fileCap) {
    const oldest = files.keys().next().value as string | undefined
    if (oldest === undefined) break
    files.delete(oldest)
  }
}

export function recordLinesWritten(owner: OwnerKey, path: string, generation: string, ranges: readonly SeenRange[]): void {
  recordSessionWrite(owner, path, generation, [...ranges])
}

function sessionWrittenRanges(owner: OwnerKey, path: string, generation: string): SeenRange[] {
  const entry = sessionWrites.get(sessionOf(owner))?.get(path)
  return entry !== undefined && entry.generation === generation ? entry.ranges : []
}

export function recordSeenLines(
  owner: OwnerKey,
  path: string,
  generation: string,
  startLine: number,
  lineCount: number,
  cuts: readonly ColumnCut[] = [],
): void {
  if (lineCount <= 0 || startLine < 1) return
  const files = ledgerFor(owner, path)
  let entry = files.get(path)
  if (!entry || entry.generation !== generation) {
    const cuts = columnCutsOf(owner, path, generation)
    entry = { generation, ranges: [], cuts: [...cuts] }
  } else {
    files.delete(path)
  }
  const endLine = startLine + lineCount - 1
  const incomplete = new Map(cuts.map(cut => [cut.line, cut.visibleChars]))
  const keptCuts = new Map((entry.cuts ?? []).map(cut => [cut.line, cut.visibleChars]))
  for (const line of keptCuts.keys()) {
    if (line >= startLine && line <= endLine && !incomplete.has(line)) keptCuts.delete(line)
  }
  for (const { line, visibleChars } of cuts) {
    if (!entry.ranges.some(range => range.start <= line && range.end >= line)) keptCuts.set(line, Math.max(visibleChars, keptCuts.get(line) ?? 0))
  }
  entry.cuts = [...keptCuts].map(([line, visibleChars]) => ({ line, visibleChars }))
  entry.ranges = coalesce([...entry.ranges, ...withoutCutLines([{ start: startLine, end: endLine }], cuts)])
  if (entry.ranges.length > SEEN_LINES_BOUNDS.rangeCap) {
    entry.ranges = entry.ranges
      .map((range, index) => ({ range, index }))
      .sort((a, b) => (b.range.end - b.range.start) - (a.range.end - a.range.start) || b.index - a.index)
      .slice(0, SEEN_LINES_BOUNDS.rangeCap)
      .sort((a, b) => a.index - b.index)
      .map(({ range }) => range)
  }
  files.set(path, entry)
  while (files.size > SEEN_LINES_BOUNDS.fileCap) {
    const oldest = files.keys().next().value as string | undefined
    if (oldest === undefined) break
    files.delete(oldest)
  }
}

function withoutCutLines(ranges: readonly SeenRange[], cuts: readonly ColumnCut[]): SeenRange[] {
  if (cuts.length === 0 || ranges.length === 0) return [...ranges]
  const lines = [...new Set(cuts.map(cut => cut.line))].sort((a, b) => a - b)
  const kept: SeenRange[] = []
  for (const range of ranges) {
    let lo = 0
    let hi = lines.length
    while (lo < hi) {
      const mid = (lo + hi) >>> 1
      if (lines[mid]! < range.start) lo = mid + 1
      else hi = mid
    }
    let start = range.start
    for (let i = lo; i < lines.length && lines[i]! <= range.end; i++) {
      const line = lines[i]!
      if (line > start) kept.push({ start, end: line - 1 })
      start = line + 1
    }
    if (start <= range.end) kept.push({ start, end: range.end })
  }
  return kept
}

export function retainColumnCuts(owner: OwnerKey, path: string, generation: string, cuts: readonly ColumnCut[]): void {
  const files = ledgerFor(owner, path)
  const entry = files.get(path)
  files.set(path, { generation, ranges: withoutCutLines(entry?.generation === generation ? entry.ranges : [], cuts), cuts: [...cuts] })
}

export function columnCutsOf(owner: OwnerKey, path: string, generation: string | null): readonly ColumnCut[] {
  const entry = store.peek(owner)?.files.get(path)
  if (entry === undefined || generation === null) return []
  const sameBytes = /^m\d+:/.test(entry.generation) && /^m\d+:/.test(generation) && entry.generation.slice(entry.generation.indexOf(':')) === generation.slice(generation.indexOf(':'))
  return entry.generation === generation || sameBytes ? entry.cuts ?? [] : []
}

export function recordDisplayedLines(owner: OwnerKey, path: string, generation: string, start: number, content: string, maxChars: number): void {
  const lines = content.split('\n')
  const cuts = lines.flatMap((line, i) => line.length > maxChars ? [{ line: start + i, visibleChars: maxChars }] : [])
  recordSeenLines(owner, path, generation, start, lines.length, cuts)
}

export function losslessReadCall(path: string, line: number): string {
  return `Read(file_path: ${JSON.stringify(path)}, offset: ${line}, limit: 1, lossless: true)`
}

export function clippedLinesRefusal(owner: OwnerKey, path: string, displayPath: string, generation: string | null, touched: readonly SeenRange[] | null): string | null {
  for (const cut of columnCutsOf(owner, path, generation)) {
    if (touched !== null && !touched.some(range => range.start <= cut.line && range.end >= cut.line)) continue
    return `Line ${cut.line} was clipped; ${losslessReadCall(displayPath, cut.line)} shows it before replacement.`
  }
  return null
}

export function seenLinesOf(
  owner: OwnerKey,
  path: string,
  generation?: string,
): { generation: string; ranges: readonly SeenRange[] } | undefined {
  const entry = store.peek(owner)?.files.get(path)
  const at = generation ?? entry?.generation ?? fileGeneration(path) ?? undefined
  const written = at === undefined ? [] : sessionWrittenRanges(owner, path, at)
  const own = entry !== undefined && entry.generation === at ? entry.ranges : []
  if (own.length === 0 && written.length === 0) return entry === undefined ? undefined : { generation: entry.generation, ranges: entry.ranges }
  return { generation: at!, ranges: withoutCutLines(coalesce([...own, ...written]), entry !== undefined && entry.generation === at ? entry.cuts ?? [] : []) }
}

export function lineCountOfText(text: string): number {
  if (text === '') return 0
  return text.split('\n').length - (text.endsWith('\n') ? 1 : 0)
}

export function generationOfWrittenBytes(path: string, bytes: Uint8Array): string | null {
  const file = readRegularFile(path, bytes.byteLength)
  return file !== null && file.bytes.equals(bytes) ? file.generation : null
}

export function recordWholeFileSeen(owner: OwnerKey, path: string, generation: string, content: string): void {
  const lines = lineCountOfText(content)
  recordSeenLines(owner, path, generation, 1, lines)
  if (lines > 0) recordSessionWrite(owner, path, generation, [{ start: 1, end: lines }])
}

export function wholeFileSeen(owner: OwnerKey, path: string, content: string): boolean {
  const generation = fileGeneration(path)
  if (generation === null) return false
  const ranges = seenLinesOf(owner, path, generation)
  if (ranges === undefined || ranges.generation !== generation) return false
  const lastLine = lineCountOfText(content)
  return lastLine > 0 && ranges.ranges.some(range => range.start <= 1 && range.end >= lastLine)
}

type SeenLinesVerdict =
  | { ok: true }
  | {
      ok: false
      unseen: SeenRange[]
      hint: string
    }

function touchedRange(span: HunkSpan): SeenRange {
  return { start: span.start, end: span.end }
}

export function checkSeenLines(
  owner: OwnerKey,
  path: string,
  generation: string,
  spans: readonly HunkSpan[],
  displayPath?: string,
): SeenLinesVerdict {
  const seen = seenLinesOf(owner, path, generation)
  const ranges = seen !== undefined && seen.generation === generation ? seen.ranges : []
  const unseen: SeenRange[] = []
  for (const span of spans) {
    const t = touchedRange(span)
    let cursor = t.start
    for (const r of ranges) {
      if (r.end < cursor) continue
      if (r.start > t.end) break
      if (r.start > cursor) unseen.push({ start: cursor, end: Math.min(r.start - 1, t.end) })
      cursor = Math.max(cursor, r.end + 1)
      if (cursor > t.end) break
    }
    if (cursor <= t.end) unseen.push({ start: cursor, end: t.end })
  }
  if (unseen.length === 0) return { ok: true }
  const merged = coalesce(unseen).slice(0, 8)
  const display = displayPath ?? path
  const spellRange = (r: SeenRange): string => (r.start === r.end ? `${r.start}` : `${r.start}-${r.end}`)
  const first = merged[0]!
  return {
    ok: false,
    unseen: merged,
    hint:
      `lines ${merged.map(spellRange).join(', ')} of ${display} were never displayed this session — ` +
      `Read(offset: ${first.start}, limit: ${first.end - first.start + 1}) the smallest missing range (and the others if needed), then re-apply`,
  }
}

export function shiftSeenLinesAfterApply(
  owner: OwnerKey,
  path: string,
  newGeneration: string,
  spans: readonly HunkSpan[],
  replacementLineCount: (span: HunkSpan) => number,
): void {
  const files = ledgerFor(owner, path)
  const entry = files.get(path)
  const oldRanges = entry?.ranges ?? []
  const events = [...spans].sort((a, b) => a.start - b.start)
  const newRanges: SeenRange[] = []

  for (const r of oldRanges) {
    let delta = 0
    let start = r.start
    let end = r.end
    let dropped = false
    for (const s of events) {
      const repLines = replacementLineCount(s)
      if (s.insert === 'before' || s.insert === 'after') {
        const at = s.insert === 'before' ? s.start : s.end + 1
        if (at <= start) delta += repLines
        else if (at <= end) end += repLines
        continue
      }
      const removed = s.end - s.start + 1
      const shift = repLines - removed
      if (s.end < start) {
        delta += shift
        continue
      }
      if (s.start > end) continue
      if (s.start <= start && s.end >= end) {
        dropped = true
        break
      }
      if (s.start > start && s.end < end) {
        end = end + shift
        continue
      }
      if (s.start <= start) {
        start = s.end + 1 + shift
        delta += shift
        continue
      }
      end = s.start - 1
    }
    if (!dropped && end >= start) newRanges.push({ start: start + delta, end: end + delta })
  }

  const authored: SeenRange[] = []
  let running = 0
  for (const s of events) {
    const repLines = replacementLineCount(s)
    if (s.insert === 'before') {
      if (repLines > 0) authored.push({ start: s.start + running, end: s.start + running + repLines - 1 })
      running += repLines
      continue
    }
    if (s.insert === 'after') {
      if (repLines > 0) authored.push({ start: s.end + 1 + running, end: s.end + running + repLines })
      running += repLines
      continue
    }
    const removed = s.end - s.start + 1
    if (repLines > 0) authored.push({ start: s.start + running, end: s.start + running + repLines - 1 })
    running += repLines - removed
  }
  newRanges.push(...authored)

  files.delete(path)
  files.set(path, { generation: newGeneration, ranges: coalesce(newRanges).slice(0, SEEN_LINES_BOUNDS.rangeCap) })
  recordSessionWrite(owner, path, newGeneration, authored)
}

export function moveSeenLines(owner: OwnerKey, fromPath: string, toPath: string, newGeneration: string): void {
  const written = sessionWrites.get(sessionOf(owner))
  const writtenEntry = written?.get(fromPath)
  if (written !== undefined && writtenEntry !== undefined) {
    written.delete(fromPath)
    written.set(toPath, { generation: newGeneration, ranges: writtenEntry.ranges })
  }
  const files = ledgerFor(owner, fromPath)
  const entry = files.get(fromPath)
  if (!entry) return
  files.delete(fromPath)
  files.set(toPath, { generation: newGeneration, ranges: entry.ranges, cuts: entry.cuts })
}

export function dropSeenLines(owner: OwnerKey, path: string): void {
  store.peek(owner)?.files.delete(path)
  sessionWrites.get(sessionOf(owner))?.delete(path)
}

export function _resetSeenLinesForTesting(): void {
  store.clearAllForShutdown()
  sessionWrites.clear()
}

const NUMBERED_LINE = /^(\d+)(?:#[0-9a-f]+)?\t([\s\S]*)$/
const TRUNCATED_TAIL = /… \[truncated \d+ characters\]$/

function shownLinesOf(text: string): Map<number, string> {
  const shown = new Map<number, string>()
  for (const line of text.split('\n')) {
    const match = NUMBERED_LINE.exec(line)
    if (match === null) continue
    const body = match[2]!
    shown.set(Number(match[1]), body)
  }
  return shown
}

function textOfResult(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.map(block => (typeof (block as { text?: unknown }).text === 'string' ? (block as { text: string }).text : '')).join('\n')
}

export function rebuildSeenLinesFromTranscript(owner: OwnerKey, messages: ReadonlyArray<unknown>, excludedResultIds?: ReadonlySet<string>): { files: number; lines: number } {
  const pathOfUse = new Map<string, { path: string; tool: string; content?: string }>()
  const summary = { files: 0, lines: 0 }
  const touched = new Set<string>()
  const results: Array<{ path: string; shown: Map<number, string> } | { path: string; written: string }> = []
  const wantedOf = new Map<string, Wanted>()
  const wantedFor = (path: string): Wanted => {
    let wanted = wantedOf.get(path)
    if (wanted === undefined) wantedOf.set(path, (wanted = { lines: new Map(), wholeUpTo: -1 }))
    return wanted
  }
  for (const row of messages) {
    const message = row as { type?: string; message?: { content?: unknown } }
    if (message.type !== 'assistant' && message.type !== 'user') continue
    const content = message.message?.content
    if (!Array.isArray(content)) continue
    for (const block of content as Array<{ type?: string; id?: string; name?: string; input?: Record<string, unknown>; tool_use_id?: string; content?: unknown; is_error?: boolean }>) {
      if (block.type === 'tool_use' && typeof block.id === 'string' && typeof block.name === 'string') {
        const input = block.input ?? {}
        const path = typeof input.file_path === 'string' ? input.file_path : typeof input.notebook_path === 'string' ? input.notebook_path : undefined
        if (path === undefined) continue
        pathOfUse.set(block.id, { path, tool: block.name, ...(block.name === 'Write' && typeof input.content === 'string' ? { content: input.content } : {}) })
        continue
      }
      if (block.type !== 'tool_result' || typeof block.tool_use_id !== 'string' || block.is_error === true || excludedResultIds?.has(block.tool_use_id)) continue
      const use = pathOfUse.get(block.tool_use_id)
      if (use === undefined) continue
      const wanted = wantedFor(use.path)
      if (use.tool === 'Write' && use.content !== undefined) {
        wanted.wholeUpTo = Math.max(wanted.wholeUpTo, Buffer.byteLength(use.content))
        results.push({ path: use.path, written: use.content })
        continue
      }
      const shown = shownLinesOf(textOfResult(block.content))
      for (const [line, body] of shown) wanted.lines.set(line, Math.max(wanted.lines.get(line) ?? 0, 3 * body.length + 8))
      results.push({ path: use.path, shown })
    }
  }
  const current = new Map<string, ({ generation: string } & Scan) | null>()
  const currentOf = (path: string): ({ generation: string } & Scan) | null => {
    if (current.has(path)) return current.get(path)!
    const scan = scanRegularFile(path, wantedFor(path))
    const state = scan === null ? null : { ...scan, generation: ideFileGeneration(path) ?? scan.generation }
    current.set(path, state)
    return state
  }
  for (const result of results) {
    const state = currentOf(result.path)
    if (state === null) continue
    if ('written' in result) {
      if (state.whole !== null && state.whole.toString('utf8') === result.written) {
        recordWholeFileSeen(owner, result.path, state.generation, result.written)
        summary.lines += result.written.split('\n').length
        touched.add(result.path)
      }
      continue
    }
    for (const [line, body] of result.shown) {
      const found = state.lines.get(line)
      if (found === undefined) continue
      if (TRUNCATED_TAIL.test(body)) {
        const prefix = body.replace(TRUNCATED_TAIL, '')
        if (found.text.startsWith(prefix) && (!found.whole || found.text.length > prefix.length)) {
          recordSeenLines(owner, result.path, state.generation, line, 1, [{ line, visibleChars: prefix.length }])
        }
        continue
      }
      if (!found.whole || found.text !== body) continue
      recordSeenLines(owner, result.path, state.generation, line, 1)
      summary.lines++
      touched.add(result.path)
    }
  }
  summary.files = touched.size
  return summary
}
