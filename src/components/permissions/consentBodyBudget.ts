
import { stringWidth } from '../../ink/stringWidth.js'
import type { StructuredPatchHunk } from '../../utils/diff.js'
import { isFullscreenEnvEnabled } from '../../utils/fullscreen.js'
import sliceAnsi from '../../utils/sliceAnsi.js'

export const CONSENT_CHROME_ROWS = 21
export const CONSENT_BODY_MIN_ROWS = 6
export const CONSENT_CARD_CHROME_COLUMNS = 4
export const CUT_MARK = '…'

export function consentBodyBudget(termRows: number): number {
  return Math.max(CONSENT_BODY_MIN_ROWS, termRows - CONSENT_CHROME_ROWS)
}

export function consentContentWidth(columns: number, innerPaddingX = 1): number {
  return Math.max(1, columns - CONSENT_CARD_CHROME_COLUMNS - innerPaddingX * 2)
}

function diffGutterDigits(hunks: readonly StructuredPatchHunk[]): number {
  let widest = 1
  for (const hunk of hunks) {
    widest = Math.max(widest, hunk.oldStart + hunk.oldLines, hunk.newStart + hunk.newLines)
  }
  return String(widest).length
}

export function diffPaintWidth(width: number, hunks: readonly StructuredPatchHunk[]): number {
  return Math.max(1, width - diffGutterDigits(hunks) - 3)
}

export function filePaintWidth(width: number, lineCount: number): number {
  if (!isFullscreenEnvEnabled()) return Math.max(1, width)
  return Math.max(1, width - (String(Math.max(1, lineCount)).length + 2))
}

export function paintedRows(line: string, paintWidth: number): number {
  const width = Math.max(1, paintWidth)
  return Math.max(1, Math.ceil(stringWidth(line) / width))
}

export function cutToRows(line: string, paintWidth: number, rows: number): string {
  const width = Math.max(1, paintWidth)
  if (rows <= 0) return CUT_MARK
  if (stringWidth(line) <= width * rows) return line
  const cells = width * rows - stringWidth(CUT_MARK)
  let head = sliceAnsi(line, 0, cells)
  if (stringWidth(head) > cells) head = sliceAnsi(line, 0, cells - 1)
  return `${head}${CUT_MARK}`
}

export type BoundedLines = {
  lines: string[]
  hiddenLines: number
  cut: boolean
}

export function boundLines(
  lines: readonly string[],
  paintWidth: number,
  budgetRows: number | null,
): BoundedLines {
  if (budgetRows === null) return { lines: [...lines], hiddenLines: 0, cut: false }
  const kept: string[] = []
  let left = budgetRows
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    const rows = paintedRows(line, paintWidth)
    if (rows <= left) {
      kept.push(line)
      left -= rows
      continue
    }
    const hidden = lines.length - i
    if (left > 0) {
      kept.push(cutToRows(line, paintWidth, left))
      return { lines: kept, hiddenLines: hidden, cut: true }
    }
    return { lines: kept, hiddenLines: hidden, cut: false }
  }
  return { lines: kept, hiddenLines: 0, cut: false }
}

function splitHunkLine(raw: string): { prefix: string; content: string } {
  const first = raw[0]
  if (first === '+' || first === '-' || first === ' ') return { prefix: first, content: raw.slice(1) }
  return { prefix: '', content: raw }
}

export type BoundedHunks = {
  hunks: StructuredPatchHunk[]
  hiddenLines: number
  cut: boolean
}

export function boundHunks(
  hunks: readonly StructuredPatchHunk[],
  paintWidth: number,
  budgetRows: number | null,
): BoundedHunks {
  if (budgetRows === null) return { hunks: [...hunks], hiddenLines: 0, cut: false }
  const kept: StructuredPatchHunk[] = []
  let left = budgetRows
  let whole = 0
  const total = hunks.reduce((n, hunk) => n + hunk.lines.length, 0)
  for (let h = 0; h < hunks.length; h++) {
    const hunk = hunks[h]!
    if (h > 0) left -= 1
    const lines: string[] = []
    for (let i = 0; i < hunk.lines.length; i++) {
      const raw = hunk.lines[i]!
      const { prefix, content } = splitHunkLine(raw)
      const rows = paintedRows(content, paintWidth)
      if (rows <= left) {
        lines.push(raw)
        left -= rows
        whole += 1
        continue
      }
      const cut = left > 0
      if (cut) lines.push(`${prefix}${cutToRows(content, paintWidth, left)}`)
      if (lines.length > 0) kept.push({ ...hunk, lines })
      return { hunks: kept, hiddenLines: total - whole, cut }
    }
    kept.push(hunk)
  }
  return { hunks: kept, hiddenLines: 0, cut: false }
}

export function totalHunkRows(hunks: readonly StructuredPatchHunk[], paintWidth: number): number {
  let rows = 0
  hunks.forEach((hunk, index) => {
    if (index > 0) rows += 1
    for (const raw of hunk.lines) rows += paintedRows(splitHunkLine(raw).content, paintWidth)
  })
  return rows
}

export function totalLineRows(lines: readonly string[], paintWidth: number): number {
  return lines.reduce((rows, line) => rows + paintedRows(line, paintWidth), 0)
}
