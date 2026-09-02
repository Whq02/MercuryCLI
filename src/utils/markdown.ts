
import chalk from 'chalk'
import { marked, type Token, type Tokens } from 'marked'
import stripAnsi from 'strip-ansi'
import { BLOCKQUOTE_BAR } from '../constants/figures.js'
import { color } from '../components/design-system/color.js'
import { supportsHyperlinks } from '../ink/session/capabilities.js'
import { createHyperlink } from './hyperlink.js'
import { stripPromptXMLTags } from './messages.js'
import { stringWidth } from '../ink/stringWidth.js'
import sliceAnsi from './sliceAnsi.js'
import { logForDebugging } from './debug.js'
import type { CliHighlight } from './cliHighlight.js'
import type { ThemeName } from './theme.js'

let markedConfigured = false

export function configureMarked(): void {
  if (markedConfigured) return
  markedConfigured = true
  marked.use({
    tokenizer: {
      del(): undefined {
        return undefined
      },
    },
  })
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
  let out = ''
  let value = n
  while (value > 0) {
    value -= 1
    out = String.fromCharCode(97 + (value % 26)) + out
    value = Math.floor(value / 26)
  }
  return out || 'a'
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


export function padAligned(
  content: string,
  displayWidth: number,
  targetWidth: number,
  align: 'left' | 'center' | 'right' | null | undefined,
): string {
  const pad = Math.max(0, targetWidth - displayWidth)
  if (align === 'right') return ' '.repeat(pad) + content
  if (align === 'center') {
    const left = Math.floor(pad / 2)
    return ' '.repeat(left) + content + ' '.repeat(pad - left)
  }
  return content + ' '.repeat(pad)
}


const MARKDOWN_MARKER_RE = /[#*`|[>\-_~+=<\\]|\n\s*\n|^\s*\d+[.)]\s|^ {4}|^\t|&#?\w+;/m

export function hasMarkdownMarkers(text: string): boolean {
  return MARKDOWN_MARKER_RE.test(text)
}


export function applyMarkdown(
  content: string,
  theme: ThemeName,
  highlight?: CliHighlight | null,
  maxWidth: number = process.stdout.columns ?? Number.POSITIVE_INFINITY,
): string {
  configureMarked()
  const stripped = stripPromptXMLTags(content)
  const tokens = marked.lexer(stripped)
  return tokens
    .map(token => formatToken(token, theme, 0, null, null, highlight, maxWidth))
    .join('')
    .trim()
}

export function stripInlineMarkdown(content: string): string {
  return content
    .split('\n')
    .map(line =>
      line
        .replace(/^\s{0,3}#{1,6}\s+/, '')
        .replace(/^\s{0,3}>\s?/, '')
        .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
        .replace(/(\*\*|__)(?=\S)([\s\S]*?\S)\1/g, '$2')
        .replace(/(^|\W)([*_])(?=\S)([^*_]*\S)\2(?=\W|$)/g, '$1$3')
        .replace(/~~(?=\S)([\s\S]*?\S)~~/g, '$1')
        .replace(/`([^`]*)`/g, '$1'),
    )
    .join('\n')
}


function renderChildren(
  tokens: Token[] | undefined,
  theme: ThemeName,
  highlight?: CliHighlight | null,
): string {
  if (!tokens) return ''
  return tokens.map(t => formatToken(t, theme, 0, undefined, undefined, highlight)).join('')
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
  listDepth: number = 0,
  orderedListNumber: number | null = null,
  parent?: Token | null,
  highlight?: CliHighlight | null,
  widthBudget: number = Number.POSITIVE_INFINITY,
): string {
  switch (token.type) {
    case 'blockquote': {
      const quote = token as Tokens.Blockquote
      const body = renderChildren(quote.tokens, theme, highlight)
      return body
        .split('\n')
        .map(line =>
          stripAnsi(line).trim() === ''
            ? line
            : `${chalk.dim(BLOCKQUOTE_BAR)} ${chalk.italic(line)}`,
        )
        .join('\n')
    }

    case 'code': {
      const code = token as Tokens.Code
      if (!highlight) return `${code.text}\n`
      const lang = code.lang?.trim() ?? ''
      if (lang && highlight.supportsLanguage(lang)) {
        return `${highlight.highlight(code.text, { language: lang })}\n`
      }
      if (lang) {
        logForDebugging(`markdown: unsupported code fence language ${lang}`)
      }
      return `${highlight.highlight(code.text, { language: 'plaintext' })}\n`
    }

    case 'codespan':
      return color('info', theme)(token.text)

    case 'em':
      return chalk.italic(renderChildren((token as Tokens.Em).tokens, theme, highlight))

    case 'strong':
      return chalk.bold(renderChildren((token as Tokens.Strong).tokens, theme, highlight))

    case 'heading': {
      const heading = token as Tokens.Heading
      const body = renderChildren(heading.tokens, theme, highlight)
      const styled =
        heading.depth === 1
          ? chalk.bold.italic.underline(body)
          : chalk.bold(body)
      return `${styled}\n\n`
    }

    case 'hr':
      return '---\n'

    case 'image':
      return (token as Tokens.Image).href

    case 'link': {
      const link = token as Tokens.Link
      if (link.href.startsWith('mailto:')) {
        return link.href.slice('mailto:'.length)
      }
      const text = link.tokens
        ? link.tokens
            .map(t => formatToken(t, theme, 0, undefined, link, highlight))
            .join('')
        : ''
      if (text.length > 0 && text !== link.href) {
        return createHyperlink(link.href, text)
      }
      return createHyperlink(link.href)
    }

    case 'list': {
      const list = token as Tokens.List
      const start = typeof list.start === 'number' ? list.start : 1
      return list.items
        .map((item, index) =>
          formatToken(
            item,
            theme,
            listDepth,
            list.ordered ? start + index : null,
            list,
            highlight,
          ),
        )
        .join('')
    }

    case 'list_item': {
      const item = token as Tokens.ListItem
      const indent = '  '.repeat(listDepth)
      return item.tokens
        .map((child, idx) => {
          const depth = child.type === 'list' ? listDepth + 1 : listDepth
          const rendered = formatToken(child, theme, depth, idx === 0 ? orderedListNumber : null, idx === 0 ? token : null, highlight)
          if (idx === 0 || child.type === 'list') return rendered
          return rendered
            .split('\n')
            .map(line => (line === '' ? line : `${indent}  ${line}`))
            .join('\n')
        })
        .join('')
    }

    case 'paragraph': {
      const paragraph = token as Tokens.Paragraph
      const body = paragraph.tokens
        ? paragraph.tokens
            .map(t => formatToken(t, theme, 0, undefined, paragraph, highlight))
            .join('')
        : ''
      if (parent?.type === 'list_item') {
        const marker =
          orderedListNumber === null ? '-' : `${formatOrdinal(orderedListNumber, listDepth)}.`
        return `${'  '.repeat(listDepth)}${marker} ${body}\n`
      }
      return `${body}\n`
    }

    case 'text': {
      const text = token as Tokens.Text
      if (parent?.type === 'link') {
        return text.text
      }
      if (parent?.type === 'list_item') {
        const body = text.tokens
          ? text.tokens.map(t => formatToken(t, theme, 0, undefined, text, highlight)).join('')
          : linkifyIssueReferences(text.text)
        const marker = listItemMarker(orderedListNumber, listDepth)
        const hung = body.split('\n').join(`\n${' '.repeat(stringWidth(marker))}`)
        return `${marker}${hung}\n`
      }
      if (text.tokens) {
        return text.tokens
          .map(t => formatToken(t, theme, 0, undefined, text, highlight))
          .join('')
      }
      return linkifyIssueReferences(text.text)
    }

    case 'table':
      return renderTable(token as Tokens.Table, theme, highlight, widthBudget)

    case 'br':
    case 'space':
      return '\n'

    case 'escape':
      return (token as Tokens.Escape).text

    case 'del':
    case 'html':
    case 'def':
      return ''

    default:
      return ''
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
