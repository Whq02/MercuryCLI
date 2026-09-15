import { mintRangeAnchor } from '../../services/changeTransaction/snapshotAnchor.js'
import { bytesPerTokenForFileType } from '../../services/tokenEstimation.js'
import { addLineNumbers } from '../../utils/file.js'
import { getDefaultFileReadingLimits } from '../FileReadTool/limits.js'
import { MAX_LINES_TO_READ } from '../FileReadTool/prompt.js'

export type LineRange = { start: number; end: number }

export const READ_THROUGH_MARGIN = 3

export type ReadThroughBound = { maxLines: number; maxTokens: number; maxRenderedChars?: number }

export type CarriedWindow = { start: number; end: number; content: string; anchor: string }

export type ReadThroughPlan = { windows: CarriedWindow[]; lineCount: number; cut: boolean }

export function readWindowBound(): ReadThroughBound {
  return { maxLines: MAX_LINES_TO_READ, maxTokens: getDefaultFileReadingLimits().maxTokens }
}

export function coalesceLineRanges(ranges: readonly LineRange[]): LineRange[] {
  const sorted = ranges.filter(range => range.end >= range.start).sort((a, b) => a.start - b.start || a.end - b.end)
  const out: LineRange[] = []
  for (const range of sorted) {
    const last = out[out.length - 1]
    if (last !== undefined && range.start <= last.end + 1) {
      if (range.end > last.end) last.end = range.end
    } else {
      out.push({ start: range.start, end: range.end })
    }
  }
  return out
}

export function spellLineRanges(ranges: readonly LineRange[]): string {
  return ranges.map(range => (range.start === range.end ? `${range.start}` : `${range.start}-${range.end}`)).join(', ')
}

export function linesOutside(touched: readonly LineRange[], read: readonly LineRange[]): LineRange[] {
  const gaps: LineRange[] = []
  for (const range of touched) {
    let cursor = range.start
    for (const seen of read) {
      if (seen.end < cursor) continue
      if (seen.start > range.end) break
      if (seen.start > cursor) gaps.push({ start: cursor, end: Math.min(seen.start - 1, range.end) })
      cursor = Math.max(cursor, seen.end + 1)
      if (cursor > range.end) break
    }
    if (cursor <= range.end) gaps.push({ start: cursor, end: range.end })
  }
  return coalesceLineRanges(gaps)
}

export function widenLineRanges(ranges: readonly LineRange[], margin: number, lastLine: number): LineRange[] {
  return coalesceLineRanges(
    ranges
      .map(range => ({ start: Math.max(1, range.start - margin), end: Math.min(lastLine, range.end + margin) }))
      .filter(range => range.end >= range.start),
  )
}

function extensionOf(path: string): string {
  const base = path.split(/[\\/]/).pop() ?? ''
  const dot = base.lastIndexOf('.')
  return dot === -1 ? '' : base.slice(dot + 1).toLowerCase()
}

function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
}

export function planReadThrough(
  content: string,
  ranges: readonly LineRange[],
  path: string,
  bound: ReadThroughBound = readWindowBound(),
  firstLine = 1,
): ReadThroughPlan {
  const lines = stripBom(content).split('\n')
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop()
  const lastLine = firstLine + lines.length - 1
  const bytesPerToken = bytesPerTokenForFileType(extensionOf(path))
  const windows: CarriedWindow[] = []
  let lineCount = 0
  let rawChars = 0
  let renderedChars = 0
  let cut = false
  for (const range of coalesceLineRanges(ranges)) {
    if (cut) break
    const start = Math.max(firstLine, range.start)
    const end = Math.min(lastLine, range.end)
    if (end < start) continue
    let taken = 0
    for (let n = start; n <= end; n++) {
      const line = lines[n - firstLine] ?? ''
      const rawCost = line.length + (rawChars > 0 ? 1 : 0)
      const renderedCost = String(n).length + 1 + line.length + 1
      if (
        lineCount + 1 > bound.maxLines ||
        Math.round((rawChars + rawCost) / bytesPerToken) > bound.maxTokens ||
        (bound.maxRenderedChars !== undefined && renderedChars + renderedCost > bound.maxRenderedChars)
      ) {
        cut = true
        break
      }
      lineCount++
      rawChars += rawCost
      renderedChars += renderedCost
      taken++
    }
    if (taken > 0) {
      const text = lines.slice(start - firstLine, start - firstLine + taken).join('\n')
      windows.push({ start, end: start + taken - 1, content: text, anchor: mintRangeAnchor(text, start, taken) })
    }
  }
  return { windows, lineCount, cut }
}

export function renderCarriedWindows(windows: readonly CarriedWindow[]): string {
  return windows.map(window => `${addLineNumbers({ content: window.content, startLine: window.start })}\n(anchor: ${window.anchor})`).join('\n\n')
}
