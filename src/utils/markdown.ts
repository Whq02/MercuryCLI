// ============================================================================
//  Markdown → ANSI rendering for the transcript: tokens, width-budgeted
//  tables, hyperlinks, and depth-aware list numbering.
//
//  Laws that look like bugs but are the contract:
//  · the width budget is TOP-LEVEL ONLY — no recursive call forwards it, so
//    a table nested in a blockquote or list item renders unbudgeted;
//  · strikethrough tokenisation is disabled (models write ~ to mean
//    "approximately" far more often than struck-through text);
//  · inline code rides the INFORMATIONAL role, never the identity accent;
//  · bare #NNN never linkifies (it guessed the repository and was wrong);
//  · the line separator is always the bare newline — a carriage return
//    shifts styled wrapped text.
// ============================================================================

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

/** Once per process: disable strikethrough tokenisation. */
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

// ── issue linkification ─────────────────────────────────────────────────────

// Qualified owner/repo#NNN references only: the owner segment excludes dots
// (hostnames must not false-positive), the repository segment allows them,
// and the preceding character must not be a word character, dot, slash or
// hyphen. Lookbehind is avoided deliberately (it defeats one engine's regex
// JIT) — the leading context is a capture that is re-emitted.
const ISSUE_REFERENCE_RE = /(^|[^\w./-])([A-Za-z0-9_-]+)\/([A-Za-z0-9_.-]+)#(\d+)/g

function linkifyIssueReferences(text: string): string {
  if (!supportsHyperlinks()) return text
  return text.replace(ISSUE_REFERENCE_RE, (_, lead: string, owner: string, repo: string, num: string) => {
    const reference = `${owner}/${repo}#${num}`
    return `${lead}${createHyperlink(`https://github.com/${owner}/${repo}/issues/${num}`, reference)}`
  })
}

// ── ordered-list numbering by depth ─────────────────────────────────────────

/** a…z, aa, ab, … (bijective base-26, lower-case). */
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

/** Depths 0 and 1 use decimal; depth 2 letters; depth 3 Roman; deeper falls
 *  back to decimal. */
function formatOrdinal(n: number, depth: number): string {
  if (depth === 2) return bijectiveLetters(n)
  if (depth === 3) return romanNumeral(n)
  return String(n)
}

// ── alignment padding ───────────────────────────────────────────────────────

/** Left is the default; centre splits the padding with the remainder on the
 *  right; right pads before the content. */
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

// ── the marker gate ─────────────────────────────────────────────────────────

// THE GATE LAW: the lexer is the per-block decision-maker — this gate is a
// pure lexer-skip for provably plain output and must never change WHAT
// renders. Two consequences: it scans the WHOLE text (a 500-char sample
// declared any message whose markdown began past the sample plain, and the
// entire message rendered unstyled), and its class is a SUPERSET of every
// construct marked renders differently from plain prose — `+`/`N)` list
// markers, `=` setext underlines, `<` html, `\` escapes, and `&…;` entities
// included (each was a miss that unrendered whole messages). A false
// positive costs one lexer pass over prose; a false negative unrenders a
// message — the asymmetry is the design. prove-markdown-marker-gate pins
// the superset property against the lexer itself.
const MARKDOWN_MARKER_RE = /[#*`|[>\-_~+=<\\]|\n\s*\n|^\s*\d+[.)]\s|^ {4}|^\t|&#?\w+;/m

export function hasMarkdownMarkers(text: string): boolean {
  return MARKDOWN_MARKER_RE.test(text)
}

// ── the entry point ─────────────────────────────────────────────────────────

export function applyMarkdown(
  content: string,
  theme: ThemeName,
  highlight?: CliHighlight | null,
  // The budget defaults to the live terminal width — or positive infinity
  // when there is no TTY (columns is undefined off a terminal), so piped
  // output keeps full-width tables.
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

/**
 * Strip INLINE markdown markers to plain words for one-line summary slots
 * (collapsed strips, row tails) that render through a bare `<Text>` with no
 * markdown pass — model text routinely carries **bold** and `code`, and a
 * plain slot must not paint the markers literally. Deliberately narrow:
 * emphasis, inline code, strikethrough, links ([text](url) → text), and
 * line-leading heading/quote markers. Block structure is the full
 * renderer's business — a summary slot collapses whitespace anyway.
 */
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

// ── token rendering ─────────────────────────────────────────────────────────

/** Render a token list at nesting depth 0 with no parent and no ordinal
 *  (the documented exceptions pass their own arguments). */
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
      // Every non-blank line is prefixed with a dim bar and italicised; the
      // text stays at normal brightness (dimming it is nearly invisible on
      // dark themes); blank lines pass through untouched.
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
      // Inline code is reference material: the INFORMATIONAL role, never
      // the identity accent.
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
      // A block like every other block: it ends its own line, so the text
      // that follows never lands on the rule (sweep #2, packet 11).
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
      // Only the FIRST child block receives the marker (idx 0 carries the
      // parent and the ordinal); a nested list renders one level deeper;
      // later blocks are indented continuations with no marker.
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
        // Raw inside a link: linkifying here would nest a second hyperlink
        // sequence and terminals honour the innermost one.
        return text.text
      }
      if (parent?.type === 'list_item') {
        // A tight list item IS a line: it ends with its own newline like the
        // loose (paragraph) form does, so items stack instead of running
        // together (sweep #2, packet 8 — the S32 rewrite dropped it).
        const body = text.tokens
          ? text.tokens.map(t => formatToken(t, theme, 0, undefined, text, highlight)).join('')
          : linkifyIssueReferences(text.text)
        const marker = listItemMarker(orderedListNumber, listDepth)
        // Source continuation lines hang under the item's text, not its marker.
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
      // An unknown token is silently dropped, never stringified.
      return ''
  }
}

// ── tables ──────────────────────────────────────────────────────────────────

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

  // Column widths from the DISPLAYED (escape-stripped) content, min 3.
  const widths = headerCells.map((cell, i) => {
    let width = Math.max(MIN_COLUMN_WIDTH, stringWidth(stripAnsi(cell)))
    for (const row of rows) {
      width = Math.max(width, stringWidth(stripAnsi(row[i] ?? '')))
    }
    return width
  })

  // While the total exceeds the budget, the widest column shrinks by one;
  // stop when no column can shrink below the minimum (three).
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

  // Over-wide cells truncate with escape-aware slicing and a single
  // ellipsis at the SAME boundary on every row — nothing misaligns, no
  // data vanishes silently.
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
