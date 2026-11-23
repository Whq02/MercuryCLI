import chalk from 'chalk'
import { marked, type MarkedToken, type Token, type Tokens } from 'marked'
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

let markedConfigured = false

export function configureMarked(): void {
  if (markedConfigured) return
  markedConfigured = true
  marked.use({ tokenizer: { del: () => undefined } })
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
  let value = Number.isFinite(n) ? Math.max(1, Math.floor(n)) : 1
  let letters = ''
  do {
    value--
    letters = String.fromCharCode(97 + value % 26) + letters
    value = Math.floor(value / 26)
  } while (value > 0)
  return letters
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
  const pad = Math.max(0, targetWidth - displayWidth)
  const left = align === 'right' ? pad : align === 'center' ? Math.floor(pad / 2) : 0
  return ' '.repeat(left) + content + ' '.repeat(pad - left)
}


const MARKDOWN_MARKER_RE = /[#*`|[>\-_~+=<\\]|\n\s*\n|^\s*\d+[.)]\s|^ {4}|^\t|&#?\w+;/m

export function hasMarkdownMarkers(text: string): boolean {
  return MARKDOWN_MARKER_RE.test(text)
}


export function applyMarkdown(
  content: string,
  theme: ThemeName,
  highlight?: CliHighlight | null,
  maxWidth = process.stdout.columns ?? Infinity,
): string {
  configureMarked()
  return marked.lexer(stripPromptXMLTags(content)).map(token => formatToken(token, theme, 0, null, null, highlight, maxWidth)).join('').trim()
}


function renderChildren(
  tokens: Token[] | undefined,
  theme: ThemeName,
  highlight?: CliHighlight | null,
): string {
  return tokens?.map(token => formatToken(token, theme, 0, null, null, highlight)).join('') ?? ''
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
  listDepth = 0,
  orderedListNumber: number | null = null,
  parent?: Token | null,
  highlight?: CliHighlight | null,
  widthBudget = Infinity,
): string {
  const current = token as MarkedToken
  const childrenOf = (owner: { tokens?: Token[] }) => owner.tokens?.map(child => formatToken(child, theme, 0, null, current, highlight)).join('') ?? ''
  switch (current.type) {
    case 'blockquote':
      return renderChildren(current.tokens, theme, highlight).split('\n').map(line =>
        stripAnsi(line).trim() ? `${chalk.dim(BLOCKQUOTE_BAR)} ${chalk.italic(line)}` : line,
      ).join('\n')
    case 'code': {
      if (!highlight) return linkifyCodeUrls(current.text) + '\n'
      const requested = current.lang?.trim() ?? ''
      let language = 'plaintext'
      if (requested && highlight.supportsLanguage(requested)) language = requested
      else if (requested) logForDebugging(`markdown: unsupported code fence language ${requested}`)
      return linkifyCodeUrls(highlight.highlight(current.text, { language })) + '\n'
    }
    case 'codespan': return color('info', theme)(current.text)
    case 'em': return chalk.italic(renderChildren(current.tokens, theme, highlight))
    case 'strong': return chalk.bold(renderChildren(current.tokens, theme, highlight))
    case 'heading': {
      const body = renderChildren(current.tokens, theme, highlight)
      return (current.depth === 1 ? chalk.bold.italic.underline(body) : chalk.bold(body)) + '\n\n'
    }
    case 'hr': return '---\n'
    case 'image': return current.href
    case 'link': {
      if (current.href.startsWith('mailto:')) return current.href.slice(7)
      const label = childrenOf(current)
      return label && label !== current.href ? createHyperlink(current.href, label) : createHyperlink(current.href)
    }
    case 'list': {
      const start = typeof current.start === 'number' ? current.start : 1
      return current.items.map((item, i) => formatToken(item, theme, listDepth, current.ordered ? start + i : null, current, highlight)).join('')
    }
    case 'list_item': {
      const indent = '  '.repeat(listDepth + 1)
      return current.tokens.map((child, i) => {
        const nested = child.type === 'list'
        const body = formatToken(child, theme, nested ? listDepth + 1 : listDepth, i === 0 ? orderedListNumber : null, i === 0 ? current : null, highlight)
        return i === 0 || nested ? body : body.split('\n').map(line => line && indent + line).join('\n')
      }).join('')
    }
    case 'paragraph': {
      const marker = parent?.type === 'list_item' ? listItemMarker(orderedListNumber, listDepth) : ''
      return marker + childrenOf(current) + '\n'
    }
    case 'text': {
      if (parent?.type === 'link') return current.text
      const body = current.tokens?.length ? childrenOf(current) : linkifyIssueReferences(current.text)
      if (parent?.type !== 'list_item') return body
      const marker = listItemMarker(orderedListNumber, listDepth)
      return marker + body.replaceAll('\n', '\n' + ' '.repeat(stringWidth(marker))) + '\n'
    }
    case 'table': return renderTable(current, theme, highlight, widthBudget)
    case 'br':
    case 'space': return '\n'
    case 'escape': return current.text
    default: return ''
  }
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
