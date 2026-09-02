
import { statSync } from 'node:fs'
import { registerOwnerScopedStore } from '../run/ownerLifecycle.js'
import type { OwnerKey } from '../run/ownerKey.js'
import { OwnerScopedStore } from '../run/ownerScopedStore.js'
import type { HunkSpan } from './hunks.js'

export const SEEN_LINES_BOUNDS = {
  rangeCap: 256,
  fileCap: 512,
} as const

export type SeenRange = { start: number; end: number }

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

export function fileGeneration(path: string): string | null {
  try {
    const st = statSync(path)
    return `m${Math.floor(st.mtimeMs)}:${st.size}`
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

export type SeenLinesVerdict =
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
  const entry = store.peek(owner)?.files.get(path)
  const ranges = entry && entry.generation === generation ? entry.ranges : []
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

  let running = 0
  for (const s of events) {
    const repLines = replacementLineCount(s)
    if (s.insert === 'before') {
      if (repLines > 0) newRanges.push({ start: s.start + running, end: s.start + running + repLines - 1 })
      running += repLines
      continue
    }
    if (s.insert === 'after') {
      if (repLines > 0) newRanges.push({ start: s.end + 1 + running, end: s.end + running + repLines })
      running += repLines
      continue
    }
    const removed = s.end - s.start + 1
    if (repLines > 0) newRanges.push({ start: s.start + running, end: s.start + running + repLines - 1 })
    running += repLines - removed
  }

  files.delete(path)
  files.set(path, { generation: newGeneration, ranges: coalesce(newRanges).slice(0, SEEN_LINES_BOUNDS.rangeCap) })
}

export function moveSeenLines(owner: OwnerKey, fromPath: string, toPath: string, newGeneration: string): void {
  const files = ledgerFor(owner, fromPath)
  const entry = files.get(fromPath)
  if (!entry) return
  files.delete(fromPath)
  files.set(toPath, { generation: newGeneration, ranges: entry.ranges })
}

export function dropSeenLines(owner: OwnerKey, path: string): void {
  store.peek(owner)?.files.delete(path)
}

export function _resetSeenLinesForTesting(): void {
  store.clearAllForShutdown()
}
