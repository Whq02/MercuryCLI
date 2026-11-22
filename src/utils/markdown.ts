import chalk from 'chalk'
import { marked, type Token, type Tokens } from 'marked'
import stripAnsi from 'strip-ansi'
import { BLOCKQUOTE_BAR } from '../constants/figures.js'
import { color } from './color.js'
import { supportsHyperlinks } from '../ink/session/capabilities.js'
import { createHyperlink, linkifyCodeUrls } from './hyperlink.js'
import { stripPromptXMLTags } from './messages/text.js'
import { stringWidth } from '../ink/stringWidth.js'
import sliceAnsi from './sliceAnsi.js'
import { logForDebugging } from './debug.js'
import type { CliHighlight } from './cliHighlight.js'
import type { ThemeName } from './theme.js'
import { notBuilt } from '../pi/holes.js'

export function configureMarked(): void {
  return notBuilt('src/utils/markdown.ts:18')
}


const ISSUE_REFERENCE_RE = /(^|[^\w./-])([A-Za-z0-9_-]+)\/([A-Za-z0-9_.-]+)#(\d+)/g

function linkifyIssueReferences(text: string): string {
  if (!supportsHyperlinks()) return text
  return text.replace(ISSUE_REFERENCE_RE, (_, lead: string, owner: string, repo: string, num: string) => {
    const reference = `${owner}/${repo}#${num}`
    return `${lead}${createHyperlink(`https://github.com/${owner}/${repo}/issues/${num}`, reference)}`
  })
}


function bijectiveLetters(n: number): string {
  return notBuilt('src/utils/markdown.ts:42')
}

const ROMAN: Array<[number, string]> = [
  [1000, 'm'], [900, 'cm'], [500, 'd'], [400, 'cd'], [100, 'c'], [90, 'xc'],
  [50, 'l'], [40, 'xl'], [10, 'x'], [9, 'ix'], [5, 'v'], [4, 'iv'], [1, 'i'],
]

function romanNumeral(n: number): string {
  let out = ''
  let value = Math.max(1, n)
  for (const [size, glyph] of ROMAN) {
    while (value >= size) {
      out += glyph
      value -= size
    }
  }
  return out
}

function formatOrdinal(n: number, depth: number): string {
  if (depth === 2) return bijectiveLetters(n)
  if (depth === 3) return romanNumeral(n)
  return String(n)
}


function padAligned(
  content: string,
  displayWidth: number,
  targetWidth: number,
  align: 'left' | 'center' | 'right' | null | undefined,
): string {
  return notBuilt('src/utils/markdown.ts:77')
}


const MARKDOWN_MARKER_RE = /[#*`|[>\-_~+=<\\]|\n\s*\n|^\s*\d+[.)]\s|^ {4}|^\t|&#?\w+;/m

export function hasMarkdownMarkers(text: string): boolean {
  return MARKDOWN_MARKER_RE.test(text)
}


export function applyMarkdown(
  content: string,
  theme: ThemeName,
  highlight?: CliHighlight | null,
  maxWidth?: number,
): string {
  return notBuilt('src/utils/markdown.ts:100')
}


function renderChildren(
  tokens: Token[] | undefined,
  theme: ThemeName,
  highlight?: CliHighlight | null,
): string {
  return notBuilt('src/utils/markdown.ts:116')
}

function listItemMarker(orderedListNumber: number | null, listDepth: number): string {
  const indent = '  '.repeat(listDepth)
  const marker =
    orderedListNumber === null ? '-' : `${formatOrdinal(orderedListNumber, listDepth)}.`
  return `${indent}${marker} `
}

export function formatToken(
  token: Token,
  theme: ThemeName,
  listDepth?: number,
  orderedListNumber?: number | null,
  parent?: Token | null,
  highlight?: CliHighlight | null,
  widthBudget?: number,
): string {
  return notBuilt('src/utils/markdown.ts:132')
}


const MIN_COLUMN_WIDTH = 3

function renderTable(
  table: Tokens.Table,
  theme: ThemeName,
  highlight: CliHighlight | null | undefined,
  widthBudget: number,
): string {
  const headerCells = table.header.map(cell =>
    renderChildren(cell.tokens, theme, highlight),
  )
  const rows = table.rows.map(row =>
    row.map(cell => renderChildren(cell.tokens, theme, highlight)),
  )
  const columns = headerCells.length

  const widths = headerCells.map((cell, i) => {
    let width = Math.max(MIN_COLUMN_WIDTH, stringWidth(stripAnsi(cell)))
    for (const row of rows) {
      width = Math.max(width, stringWidth(stripAnsi(row[i] ?? '')))
    }
    return width
  })

  let tableW = widths.reduce((a, w) => a + w, 0) + 3 * columns + 1
  while (tableW > widthBudget) {
    let widest = 0
    for (let i = 1; i < widths.length; i++) {
      if (widths[i]! > widths[widest]!) widest = i
    }
    if (widths[widest]! <= 3) break
    widths[widest]! -= 1
    tableW -= 1
  }

  const fit = (content: string, width: number): string => {
    const displayed = stringWidth(stripAnsi(content))
    if (displayed <= width) return content
    return sliceAnsi(content, 0, Math.max(1, width - 1)) + '…'
  }

  const renderRow = (cells: string[]): string => {
    let out = ''
    for (let i = 0; i < columns; i++) {
      const cell = fit(cells[i] ?? '', widths[i]!)
      const displayed = stringWidth(stripAnsi(cell))
      out += `| ${padAligned(cell, displayed, widths[i]!, table.align[i])} `
    }
    return `${out}|`.replace(/\s+$/, '')
  }

  const separator = `${widths.map(w => `| ${'-'.repeat(w)} `).join('')}|`.replace(/\s+$/, '')

  const lines = [renderRow(headerCells), separator, ...rows.map(renderRow)]
  return `${lines.join('\n')}\n\n`
}
