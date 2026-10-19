
import { readFileSync, statSync } from 'node:fs'
import { ideFileGeneration } from '../acp/ideToolBridge.js'
import { runtimeKernel } from '../primitives/runtimeKernel.js'
import { registerOwnerScopedStore } from '../run/ownerLifecycle.js'
import { parseOwnerKey, type OwnerKey } from '../run/ownerKey.js'
import { OwnerScopedStore } from '../run/ownerScopedStore.js'
import type { HunkSpan } from './hunks.js'

export const SEEN_LINES_BOUNDS = {
  rangeCap: 256,
  fileCap: 512,
} as const

type SeenRange = { start: number; end: number }

interface FileLedger {
  generation: string
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

export function fileGeneration(path: string): string | null {
  const ideGen = ideFileGeneration(path)
  if (ideGen !== null) return ideGen
  try {
    return `${generationOf(statSync(path))}:${contentDigestOf(readFileSync(path))}`
  } catch {
    return null
  }
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
): void {
  if (lineCount <= 0 || startLine < 1) return
  const files = ledgerFor(owner, path)
  let entry = files.get(path)
  if (!entry || entry.generation !== generation) {
    entry = { generation, ranges: [] }
  } else {
    files.delete(path)
  }
  entry.ranges.push({ start: startLine, end: startLine + lineCount - 1 })
  entry.ranges = coalesce(entry.ranges)
  while (entry.ranges.length > SEEN_LINES_BOUNDS.rangeCap) {
    let smallest = 0
    for (let i = 1; i < entry.ranges.length; i++) {
      const a = entry.ranges[i]!
      const b = entry.ranges[smallest]!
      if (a.end - a.start < b.end - b.start) smallest = i
    }
    entry.ranges.splice(smallest, 1)
  }
  files.set(path, entry)
  while (files.size > SEEN_LINES_BOUNDS.fileCap) {
    const oldest = files.keys().next().value as string | undefined
    if (oldest === undefined) break
    files.delete(oldest)
  }
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
  return { generation: at!, ranges: coalesce([...own, ...written]) }
}

function lineCountOfText(text: string): number {
  if (text === '') return 0
  return text.split('\n').length - (text.endsWith('\n') ? 1 : 0)
}

export function generationOfWrittenBytes(path: string, bytes: Uint8Array): string | null {
  try {
    const st = statSync(path)
    if (st.size !== bytes.byteLength || !readFileSync(path).equals(bytes)) return null
    return `${generationOf(st)}:${contentDigestOf(bytes)}`
  } catch {
    return null
  }
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
  files.set(toPath, { generation: newGeneration, ranges: entry.ranges })
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
    if (TRUNCATED_TAIL.test(body)) continue
    shown.set(Number(match[1]), body)
  }
  return shown
}

function textOfResult(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.map(block => (typeof (block as { text?: unknown }).text === 'string' ? (block as { text: string }).text : '')).join('\n')
}

export function rebuildSeenLinesFromTranscript(owner: OwnerKey, messages: ReadonlyArray<unknown>): { files: number; lines: number } {
  const pathOfUse = new Map<string, { path: string; tool: string; content?: string }>()
  const summary = { files: 0, lines: 0 }
  const touched = new Set<string>()
  const currentLines = new Map<string, { generation: string; lines: string[] } | null>()
  const linesOf = (path: string): { generation: string; lines: string[] } | null => {
    if (currentLines.has(path)) return currentLines.get(path)!
    let state: { generation: string; lines: string[] } | null = null
    try {
      const generation = fileGeneration(path)
      if (generation !== null) state = { generation, lines: readFileSync(path, 'utf8').split('\n') }
    } catch {
      state = null
    }
    currentLines.set(path, state)
    return state
  }
  const credit = (path: string, shown: Map<number, string>): void => {
    const state = linesOf(path)
    if (state === null || shown.size === 0) return
    for (const [line, body] of shown) {
      if (line < 1 || line > state.lines.length || state.lines[line - 1] !== body) continue
      recordSeenLines(owner, path, state.generation, line, 1)
      summary.lines++
      touched.add(path)
    }
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
      if (block.type !== 'tool_result' || typeof block.tool_use_id !== 'string' || block.is_error === true) continue
      const use = pathOfUse.get(block.tool_use_id)
      if (use === undefined) continue
      if (use.tool === 'Write' && use.content !== undefined) {
        const state = linesOf(use.path)
        if (state !== null && state.lines.join('\n') === use.content) {
          recordWholeFileSeen(owner, use.path, state.generation, use.content)
          summary.lines += state.lines.length
          touched.add(use.path)
        }
        continue
      }
      credit(use.path, shownLinesOf(textOfResult(block.content)))
    }
  }
  summary.files = touched.size
  return summary
}
