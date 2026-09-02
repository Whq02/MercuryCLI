// Markdown tables as measured layout: ideal/minimum column widths
// from display measurement, proportional distribution, a vertical key/value
// degrade when rows grow past four lines or only mid-word breaking would
// fit, and a post-assembly re-measure that catches resize races. The whole
// table is ONE ANSI block so the layout engine can never wrap mid-row.

import React from 'react'
import type { Tokens } from 'marked'
import wrapAnsi from 'wrap-ansi'
import { Box } from '../ink.js'
import { Ansi } from '../ink.js'
import { stringWidth } from '../ink/stringWidth.js'
import sliceAnsi from '../utils/sliceAnsi.js'
import { useTerminalSize } from '../hooks/useTerminalSize.js'
import { useTheme } from './design-system/ThemeProvider.js'
import { applyMarkdown } from '../utils/markdown.js'
import type { CliHighlight } from '../utils/cliHighlight.js'

const MIN_COLUMN_WIDTH = 3
const SAFETY_MARGIN = 4
const MAX_ROW_LINES = 4

type Cell = { text: string }

function inlineText(
  raw: string,
  themeName: Parameters<typeof applyMarkdown>[1],
  highlight: CliHighlight | null | undefined,
): string {
  // Cell text renders through the shared inline formatter, collapsed to one
  // line.
  return applyMarkdown(raw, themeName, highlight, Number.POSITIVE_INFINITY)
    .replace(/\n+/g, ' ')
    .trim()
}

function longestWordWidth(text: string): number {
  let widest = 0
  for (const word of text.split(/\s+/)) {
    widest = Math.max(widest, stringWidth(word))
  }
  return widest
}

/** Wrap a cell: ANSI-aware, trailing whitespace trimmed FIRST (the formatter
 *  appends line ends that would otherwise create blank cell lines), empty
 *  lines filtered, at least one line returned. */
function wrapCell(text: string, width: number, hard: boolean): string[] {
  const w = Math.max(1, width)
  const lines = wrapAnsi(text.replace(/\s+$/, ''), w, {
    hard,
    trim: true,
  })
    .split('\n')
    .filter(line => line.trim() !== '')
  // The ONE-width-table law. wrap-ansi breaks by ITS
  // width table while the pads measure through the estate oracle — a line
  // the two tables disagree on overflowed its column and shoved the row's
  // borders. Any line the ORACLE still measures over-wide re-breaks here
  // through the cluster-true slicer, so break and pad can never disagree.
  const out: string[] = []
  for (let line of lines) {
    while (stringWidth(line) > w) {
      const head = sliceAnsi(line, 0, w)
      if (head === '' || stringWidth(head) === 0 || head === line) break
      out.push(head)
      line = sliceAnsi(line, stringWidth(head))
    }
    out.push(line)
  }
  return out.length > 0 ? out : ['']
}

function padTo(text: string, width: number, align: string): string {
  const deficit = Math.max(0, width - stringWidth(text))
  if (align === 'right') return ' '.repeat(deficit) + text
  if (align === 'center') {
    const left = Math.floor(deficit / 2)
    return ' '.repeat(left) + text + ' '.repeat(deficit - left)
  }
  return text + ' '.repeat(deficit)
}

export function MarkdownTable({
  token,
  highlight,
  forceWidth,
}: {
  token: Tokens.Table
  highlight?: CliHighlight | null
  forceWidth?: number
}): React.ReactNode {
  const { columns: termColumns } = useTerminalSize()
  const [themeName] = useTheme()
  const terminalWidth = forceWidth ?? termColumns

  const headers: Cell[] = token.header.map(cell => ({
    text: inlineText(cell.text, themeName, highlight),
  }))
  const rows: Cell[][] = token.rows.map(row =>
    row.map(cell => ({ text: inlineText(cell.text, themeName, highlight) })),
  )
  const columnCount = headers.length
  if (columnCount === 0) return null
  const aligns = token.align.map(a => a ?? 'left')

  // Per-column minimum (longest word) and ideal (full content) widths.
  const minWidths = headers.map((h, c) =>
    Math.max(
      MIN_COLUMN_WIDTH,
      longestWordWidth(h.text),
      ...rows.map(row => longestWordWidth(row[c]?.text ?? '')),
    ),
  )
  const idealWidths = headers.map((h, c) =>
    Math.max(
      MIN_COLUMN_WIDTH,
      stringWidth(h.text),
      ...rows.map(row => stringWidth(row[c]?.text ?? '')),
    ),
  )

  const overhead = 1 + 3 * columnCount
  const available = Math.max(
    columnCount * MIN_COLUMN_WIDTH,
    terminalWidth - overhead - SAFETY_MARGIN,
  )
  const idealTotal = idealWidths.reduce((a, b) => a + b, 0)
  const minTotal = minWidths.reduce((a, b) => a + b, 0)

  let widths: number[]
  let hardBreak = false
  if (idealTotal <= available) {
    widths = idealWidths
  } else if (minTotal <= available) {
    // Minimums plus the remainder distributed proportionally to overflow.
    const spare = available - minTotal
    const overflows = idealWidths.map((w, c) => w - minWidths[c]!)
    const overflowTotal = overflows.reduce((a, b) => a + b, 0)
    widths = minWidths.map(
      (w, c) =>
        w +
        (overflowTotal > 0
          ? Math.floor((spare * overflows[c]!) / overflowTotal)
          : 0),
    )
  } else {
    // Scale minimums proportionally; hard breaking would be required.
    widths = minWidths.map(w =>
      Math.max(MIN_COLUMN_WIDTH, Math.floor((w * available) / minTotal)),
    )
    hardBreak = true
  }

  const wrappedRows = rows.map(row =>
    row.map((cell, c) => wrapCell(cell.text, widths[c]!, hardBreak)),
  )
  const tallest = Math.max(1, ...wrappedRows.map(row => Math.max(1, ...row.map(cell => cell.length))))

  // Mid-word breaks are an unacceptable output: degrade to per-row records
  // rather than splitting words; the same when rows grow too tall.
  const vertical = hardBreak || tallest > MAX_ROW_LINES

  const lines: string[] = []
  if (!vertical) {
    const wrappedHeader = headers.map((cell, c) =>
      wrapCell(cell.text, widths[c]!, false),
    )
    const border = (left: string, mid: string, right: string): string =>
      left + widths.map(w => '─'.repeat(w + 2)).join(mid) + right

    const emitRow = (cells: string[][], header: boolean): void => {
      const height = Math.max(...cells.map(cell => cell.length))
      for (let line = 0; line < height; line++) {
        const parts = cells.map((cell, c) => {
          // Multi-line cells centre vertically; headers centre horizontally.
          const offset = Math.floor((height - cell.length) / 2)
          const text = cell[line - offset] ?? ''
          return ` ${padTo(text, widths[c]!, header ? 'center' : aligns[c]!)} `
        })
        lines.push('│' + parts.join('│') + '│')
      }
    }

    lines.push(border('┌', '┬', '┐'))
    emitRow(wrappedHeader, true)
    lines.push(border('├', '┼', '┤'))
    wrappedRows.forEach((row, index) => {
      emitRow(row, false)
      if (index < wrappedRows.length - 1) lines.push(border('├', '┼', '┤'))
    })
    lines.push(border('└', '┴', '┘'))

    // Post-assembly re-measure: a resize race can leave lines wider than the
    // terminal — fall back to the vertical form.
    const tooWide = lines.some(line => stringWidth(line) > terminalWidth - 4)
    if (!tooWide) {
      return (
        <Box>
          <Ansi>{lines.join('\n')}</Ansi>
        </Box>
      )
    }
    lines.length = 0
  }

  // The vertical key/value form.
  const ruleWidth = Math.min(terminalWidth - 1, 40)
  rows.forEach((row, rowIndex) => {
    if (rowIndex > 0) lines.push('─'.repeat(Math.max(1, ruleWidth)))
    row.forEach((cell, c) => {
      const label = headers[c]?.text || `column ${c + 1}`
      const value = cell.text.replace(/\s+/g, ' ').trim()
      const labelWidth = stringWidth(label)
      const firstWidth = Math.max(10, terminalWidth - labelWidth - 3)
      let valueLines = wrapCell(value, firstWidth, false)
      const continuationWidth = terminalWidth - 3
      if (valueLines.length > 1 && continuationWidth > firstWidth) {
        // Re-join the tail and re-wrap against the genuinely wider width.
        const tail = valueLines.slice(1).join(' ')
        valueLines = [
          valueLines[0]!,
          ...wrapCell(tail, continuationWidth, false),
        ]
      }
      lines.push(`\u001b[1m${label}\u001b[22m ${valueLines[0] ?? ''}`)
      for (const continuation of valueLines.slice(1)) {
        if (continuation.trim() === '') continue
        lines.push(`  ${continuation}`)
      }
    })
  })

  return (
    <Box>
      <Ansi>{lines.join('\n')}</Ansi>
    </Box>
  )
}

export default MarkdownTable
