
import { isEnvDefinedFalsy } from '../../utils/envUtils.js'
import { flagEnv } from '../../substrate/flagRegistry.js'
import { runtimeKernel } from '../primitives/runtimeKernel.js'
import { changeTransactionEnabled } from './contracts.js'
import { normalizeForAnchor } from './snapshotAnchor.js'

export function lineAnchorsEnabled(): boolean {
  return changeTransactionEnabled() && !isEnvDefinedFalsy(flagEnv('MERCURY_LINE_ANCHORS'))
}

export const LINE_ANCHOR_HEX = 4

export const NEIGHBORHOOD_CONTEXT_LINES = 2

export const NEIGHBORHOOD_ROW_CAP = 30

export const RELOCATION_SEARCH_RADIUS = 40

export const RELOCATION_CANDIDATE_CAP = 3

export function mintLineHash(lineText: string): string {
  return runtimeKernel().hash.sha256Hex(lineText).slice(0, LINE_ANCHOR_HEX)
}

export function anchorDomainLines(content: string): string[] {
  const normalized = normalizeForAnchor(content)
  if (normalized === '') return []
  const lines = normalized.split('\n')
  if (normalized.endsWith('\n')) lines.pop()
  return lines
}

export function formatLineAnchor(lineNumber: number, lineText: string): string {
  return `${lineNumber}#${mintLineHash(lineText)}`
}


export function addAnchoredLineNumbers({
  content,
  startLine,
  compact,
}: {
  content: string
  startLine: number
  compact: boolean
}): string {
  if (content === '') return ''
  const unmarked =
    startLine === 1 && content.charCodeAt(0) === 0xfeff ? content.slice(1) : content
  return unmarked
    .split(/\r\n|\r|\n/)
    .map((line, index) => {
      const lineNumber = startLine + index
      const prefix = `${lineNumber}#${mintLineHash(line)}`
      if (compact) return `${prefix}\t${line}`
      return prefix.length >= 11 ? `${prefix}→${line}` : `${prefix.padStart(11, ' ')}→${line}`
    })
    .join('\n')
}


export interface LineRef {
  line: number
  hash: string
}

const LINE_REF_RE = new RegExp(`^(\\d+)#([0-9a-f]{${LINE_ANCHOR_HEX}})$`)

export function parseLineRef(spelling: string): LineRef | null {
  const m = LINE_REF_RE.exec(spelling)
  if (!m) return null
  const line = Number(m[1])
  if (!Number.isSafeInteger(line) || line < 1) return null
  return { line, hash: m[2]! }
}

export type HashedLinesParse =
  | { ok: true; start: LineRef; end: LineRef }
  | { ok: false; message: string }
  | null

export function parseHashedLinesSpelling(spelling: string): HashedLinesParse {
  const trimmed = spelling.trim()
  if (!trimmed.includes('#')) return null
  const parts = trimmed.split('-')
  if (parts.length > 2) {
    return { ok: false, message: `'${spelling}' does not parse — a hash-qualified range is "N#hhhh-M#gggg" (one dash)` }
  }
  const start = parseLineRef(parts[0]!)
  if (!start) {
    return { ok: false, message: `'${spelling}' does not parse — a hash-qualified line is "N#hhhh" (${LINE_ANCHOR_HEX} lowercase hex from the anchored read)` }
  }
  if (parts.length === 1) return { ok: true, start, end: start }
  const end = parseLineRef(parts[1]!)
  if (!end) {
    return { ok: false, message: `'${spelling}' half-qualifies its range — carry BOTH endpoint anchors ("N#hhhh-M#gggg"), exactly as the anchored read presented them` }
  }
  if (end.line < start.line) {
    return { ok: false, message: `'${spelling}' ends before it starts` }
  }
  return { ok: true, start, end }
}


export type LineRefCheck =
  | { ok: true }
  | {
      ok: false
      line: number
      expectedHash: string
      currentHash: string | null
    }

export function verifyLineRef(domainLines: string[], ref: LineRef): LineRefCheck {
  if (ref.line < 1 || ref.line > domainLines.length) {
    return { ok: false, line: ref.line, expectedHash: ref.hash, currentHash: null }
  }
  const current = mintLineHash(domainLines[ref.line - 1]!)
  if (current !== ref.hash) {
    return { ok: false, line: ref.line, expectedHash: ref.hash, currentHash: current }
  }
  return { ok: true }
}


export function neighborhoodRows(
  domainLines: string[],
  spanStart: number,
  spanEnd: number,
  context: number = NEIGHBORHOOD_CONTEXT_LINES,
  cap: number = NEIGHBORHOOD_ROW_CAP,
): string[] {
  if (domainLines.length === 0) return []
  const from = Math.max(1, Math.min(spanStart, spanEnd) - context)
  const to = Math.min(domainLines.length, Math.max(spanStart, spanEnd) + context)
  const row = (n: number): string => `${formatLineAnchor(n, domainLines[n - 1]!)}\t${domainLines[n - 1]!}`
  const total = to - from + 1
  if (total <= cap) {
    const rows: string[] = []
    for (let n = from; n <= to; n++) rows.push(row(n))
    return rows
  }
  const head = Math.ceil((cap - 1) / 2)
  const tail = cap - 1 - head
  const rows: string[] = []
  for (let n = from; n < from + head; n++) rows.push(row(n))
  rows.push(`… ${total - head - tail} more line(s) — re-read for the full window …`)
  for (let n = to - tail + 1; n <= to; n++) rows.push(row(n))
  return rows
}

export function formatStaleLineAnchorRefusal(opts: {
  hunkIndex: number
  spelling: string
  failure: Extract<LineRefCheck, { ok: false }>
  domainLines: string[]
}): string {
  const { hunkIndex, spelling, failure, domainLines } = opts
  const out: string[] = []
  if (failure.currentHash === null) {
    out.push(
      `hunk ${hunkIndex}: stale line anchor — '${spelling}' addresses line ${failure.line}, but the file has ${domainLines.length} line(s).`,
    )
  } else {
    out.push(
      `hunk ${hunkIndex}: stale line anchor — line ${failure.line} no longer carries #${failure.expectedHash} (current: ${failure.line}#${failure.currentHash}).`,
    )
  }
  const candidates = findRelocationCandidates(domainLines, failure.expectedHash, failure.line)
  if (candidates.length > 0) {
    out.push(`moved_to: ${candidates.map(n => formatLineAnchor(n, domainLines[n - 1]!)).join('  ')}`)
  }
  if (domainLines.length > 0) {
    const center = Math.min(Math.max(1, failure.line), domainLines.length)
    const from = Math.max(1, center - NEIGHBORHOOD_CONTEXT_LINES)
    const to = Math.min(domainLines.length, center + NEIGHBORHOOD_CONTEXT_LINES)
    out.push(`current anchors (lines ${from}-${to}):`)
    out.push(...neighborhoodRows(domainLines, center, center))
  }
  out.push('Re-aim at the anchors above (or re-read the file if the drift is wider).')
  return out.join('\n')
}

export function formatFreshAnchorBlocks(
  domainLines: string[],
  regions: Array<{ start: number; lineCount: number }>,
): string {
  if (domainLines.length === 0 || regions.length === 0) return ''
  const out: string[] = ['fresh anchors:']
  for (const region of regions) {
    if (region.lineCount === 0) {
      const seamStart = Math.max(1, Math.min(region.start - 1, domainLines.length))
      const seamEnd = Math.min(domainLines.length, Math.max(seamStart, region.start))
      out.push(`lines ${seamStart}-${seamEnd} (around the removal) now:`)
      out.push(...neighborhoodRows(domainLines, seamStart, seamEnd))
    } else {
      const end = Math.min(domainLines.length, region.start + region.lineCount - 1)
      out.push(`lines ${region.start}-${end} now:`)
      out.push(...neighborhoodRows(domainLines, region.start, end))
    }
  }
  return out.join('\n')
}

export function findRelocationCandidates(
  domainLines: string[],
  expectedHash: string,
  aim: number,
  radius: number = RELOCATION_SEARCH_RADIUS,
  cap: number = RELOCATION_CANDIDATE_CAP,
): number[] {
  const from = Math.max(1, aim - radius)
  const to = Math.min(domainLines.length, aim + radius)
  const hits: number[] = []
  for (let n = from; n <= to; n++) {
    if (mintLineHash(domainLines[n - 1]!) === expectedHash) hits.push(n)
  }
  hits.sort((a, b) => Math.abs(a - aim) - Math.abs(b - aim) || a - b)
  return hits.slice(0, cap)
}
