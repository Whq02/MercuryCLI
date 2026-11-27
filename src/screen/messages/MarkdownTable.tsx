import React from 'react'
import type { Tokens } from 'marked'
import wrapAnsi from 'wrap-ansi'
import { Box } from '../themedRenderer.js'
import { Ansi } from '../themedRenderer.js'
import { stringWidth } from '../renderer/stringWidth.js'
import sliceAnsi from '../../platform/text/sliceAnsi.js'
import { useTerminalSize } from '../fullscreen-layout/useTerminalSize.js'
import { useTheme } from '../theme/ThemeProvider.js'
import { applyMarkdown } from './markdownText.js'
import type { CliHighlight } from '../highlighted-code/cliHighlight.js'

const MIN_COL_WIDTH = 3
const MAX_ROW_LINES = 4

type Cell = { text: string }

function inlineText(
  raw: string,
  themeName: Parameters<typeof applyMarkdown>[1],
  highlight: CliHighlight | null | undefined,
  literalBackslashes: boolean,
): string {
  return applyMarkdown(raw, themeName, highlight, Number.POSITIVE_INFINITY, literalBackslashes)
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

function padTo(text: string, width: number, align: string): string {
  const deficit = Math.max(0, width - stringWidth(text))
  if (align === 'right') return ' '.repeat(deficit) + text
  if (align === 'center') {
    const left = Math.floor(deficit / 2)
    return ' '.repeat(left) + text + ' '.repeat(deficit - left)
  }
  return text + ' '.repeat(deficit)
}

function wrapCell(text: string, width: number): string[] {
  if (text === '') return ['']
  const wrapped = wrapAnsi(text, width, { hard: false, trim: false, wordWrap: true })
  const out: string[] = []
  for (const rawLine of wrapped.split('\n')) {
    const line = rawLine.trimEnd()
    if (stringWidth(line) <= width) {
      out.push(line)
    } else {
      let offset = 0
      const total = stringWidth(line)
      while (offset < total) {
        out.push(sliceAnsi(line, offset, offset + width))
        offset += width
      }
    }
  }
  return out.length > 0 ? out : ['']
}

function renderHorizontalRow(
  cellLines: string[][],
  widths: number[],
  aligns: string[],
  isHeader: boolean,
): string[] {
  const rowHeight = Math.max(1, ...cellLines.map(lines => lines.length))
  const rendered: string[] = []
  for (let lineIdx = 0; lineIdx < rowHeight; lineIdx++) {
    const cells = cellLines.map((lines, c) => {
      const topPad = Math.floor((rowHeight - lines.length) / 2)
      const content =
        lineIdx >= topPad && lineIdx < topPad + lines.length
          ? lines[lineIdx - topPad]!
          : ''
      const align = isHeader ? 'center' : (aligns[c] ?? 'left')
      const padded = padTo(content, widths[c]!, align)
      return isHeader ? `\x1b[1m${padded}\x1b[22m` : padded
    })
    rendered.push(`│ ${cells.join(' │ ')} │`)
  }
  return rendered
}

function renderVerticalCards(
  headers: string[],
  rows: string[][],
  terminalWidth: number,
): string {
  const maxWidth = Math.max(10, terminalWidth - 4)
  const contBudget = Math.max(10, maxWidth - 2)
  const ruleWidth = Math.max(1, Math.min(40, terminalWidth - 1))
  const rule = '─'.repeat(ruleWidth)
  const blocks: string[] = []

  for (const row of rows) {
    const lines: string[] = []
    for (let c = 0; c < headers.length; c++) {
      const label = headers[c] || `column ${c + 1}`
      const value = row[c] ?? ''
      const prefixWidth = stringWidth(label) + 2
      const firstLineBudget = Math.max(10, maxWidth - prefixWidth)
      if (value === '') {
        lines.push(`\x1b[1m${label}\x1b[22m: `)
        continue
      }
      const firstPass = wrapAnsi(value, firstLineBudget, {
        hard: false,
        trim: false,
        wordWrap: true,
      })
        .split('\n')
        .map(line => line.trimEnd())
      const firstLine = firstPass[0] ?? ''
      lines.push(`\x1b[1m${label}\x1b[22m: ${firstLine}`)
      const remainder = firstPass.slice(1).join(' ').trim()
      if (remainder !== '') {
        const contLines = wrapAnsi(remainder, contBudget, {
          hard: false,
          trim: false,
          wordWrap: true,
        })
          .split('\n')
          .map(line => line.trimEnd())
          .filter(line => line.trim() !== '')
        for (const contLine of contLines) {
          lines.push(`  ${contLine}`)
        }
      }
    }
    blocks.push(lines.join('\n'))
  }

  return blocks.join(`\n${rule}\n`)
}

export function MarkdownTable({
  token,
  highlight,
  forceWidth,
  literalBackslashes = false,
}: {
  token: Tokens.Table
  highlight?: CliHighlight | null
  forceWidth?: number
  literalBackslashes?: boolean
}): React.ReactNode {
  const { columns: termColumns } = useTerminalSize()
  const [themeName] = useTheme()
  const terminalWidth = forceWidth ?? termColumns

  const headers = token.header.map((cell: Cell) => inlineText(cell.text, themeName, highlight, literalBackslashes))
  const columnCount = headers.length
  if (columnCount === 0) return null

  const rows = token.rows.map(row =>
    Array.from({ length: columnCount }, (_, c) => {
      const cell: Cell | undefined = row[c]
      return inlineText(cell?.text ?? '', themeName, highlight, literalBackslashes)
    }),
  )
  const aligns = Array.from({ length: columnCount }, (_, c) => token.align[c] ?? 'left')

  const idealWidths = headers.map((header, c) =>
    Math.max(
      MIN_COL_WIDTH,
      stringWidth(header),
      ...rows.map(row => stringWidth(row[c] ?? '')),
    ),
  )
  const minWidths = headers.map((header, c) =>
    Math.max(
      MIN_COL_WIDTH,
      longestWordWidth(header),
      ...rows.map(row => longestWordWidth(row[c] ?? '')),
    ),
  )

  const overhead = 1 + 3 * columnCount + 4
  const available = terminalWidth - overhead
  const idealTotal = idealWidths.reduce((sum, w) => sum + w, 0)
  const minTotal = minWidths.reduce((sum, w) => sum + w, 0)

  let output: string
  if (minTotal > available) {
    output = renderVerticalCards(headers, rows, terminalWidth)
  } else {
    let widths: number[]
    if (idealTotal <= available) {
      widths = idealWidths
    } else {
      const spare = available - minTotal
      const wants = idealWidths.map((ideal, c) => Math.max(0, ideal - minWidths[c]!))
      const totalWant = wants.reduce((sum, w) => sum + w, 0)
      widths = minWidths.map((min, c) =>
        totalWant === 0 ? min : min + Math.floor((spare * wants[c]!) / totalWant),
      )
    }
    const wrappedHeader = headers.map((cell, c) => wrapCell(cell, widths[c]!))
    const wrappedRows = rows.map(row =>
      row.map((cell, c) => wrapCell(cell, widths[c]!)),
    )
    const exceedsRowLines =
      wrappedHeader.some(lines => lines.length > MAX_ROW_LINES) ||
      wrappedRows.some(row => row.some(lines => lines.length > MAX_ROW_LINES))

    if (exceedsRowLines) {
      output = renderVerticalCards(headers, rows, terminalWidth)
    } else {
      const top = `┌${widths.map(w => '─'.repeat(w + 2)).join('┬')}┐`
      const mid = `├${widths.map(w => '─'.repeat(w + 2)).join('┼')}┤`
      const bot = `└${widths.map(w => '─'.repeat(w + 2)).join('┴')}┘`
      const boxLines: string[] = [
        top,
        ...renderHorizontalRow(wrappedHeader, widths, aligns, true),
      ]
      for (const row of wrappedRows) {
        boxLines.push(mid)
        boxLines.push(...renderHorizontalRow(row, widths, aligns, false))
      }
      boxLines.push(bot)

      const maxLineWidth = terminalWidth - 4
      if (boxLines.some(line => stringWidth(line) > maxLineWidth)) {
        output = renderVerticalCards(headers, rows, terminalWidth)
      } else {
        output = boxLines.join('\n')
      }
    }
  }

  return (
    <Box flexDirection="column">
      <Ansi>{output}</Ansi>
    </Box>
  )
}

export default MarkdownTable
