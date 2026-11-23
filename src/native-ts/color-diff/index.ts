import { shouldSkipHighlight } from '../../utils/cliHighlight.js'
import { diffArrays } from 'diff'
import { truecolorActive } from '../../ink/colorize.js'
import { stringWidth } from '../../ink/stringWidth.js'
import { expandTabs } from '../../ink/tabstops.js'
import { logError } from '../../utils/log.js'

function charWidth(char: string): number {
  return stringWidth(char)
}


type Color = { r: number; g: number; b: number; a: number }

function rgb(r: number, g: number, b: number): Color {
  return { r, g, b, a: 255 }
}

function paletteIndex(index: number): Color {
  return { r: index, g: 0, b: 0, a: 0 }
}

const TERMINAL_DEFAULT: Color = { r: 0, g: 0, b: 0, a: 1 }

type ColorMode = 'truecolor' | 'color256'

function detectColorMode(): ColorMode {
  return truecolorActive() ? 'truecolor' : 'color256'
}


const CHANNEL_THRESHOLDS = [48, 115, 155, 195, 235]

const CUBE_LEVELS = [0, 95, 135, 175, 215, 255]

function cubeIndex(channel: number): number {
  for (let i = 0; i < CHANNEL_THRESHOLDS.length; i++) {
    if (channel < CHANNEL_THRESHOLDS[i]!) return i
  }
  return 5
}

function quantizeToAnsi256(r: number, g: number, b: number): number {
  const ri = cubeIndex(r)
  const gi = cubeIndex(g)
  const bi = cubeIndex(b)
  const cr = CUBE_LEVELS[ri]!
  const cg = CUBE_LEVELS[gi]!
  const cb = CUBE_LEVELS[bi]!
  const cubeCode = 16 + 36 * ri + 6 * gi + bi
  const cubeDist = (r - cr) ** 2 + (g - cg) ** 2 + (b - cb) ** 2

  const mean = (r + g + b) / 3
  if (mean > 244) return cubeCode
  let grayCode: number
  let grayLevel: number
  if (mean < 5) {
    grayCode = 16
    grayLevel = 0
  } else {
    const step = Math.max(0, Math.min(23, Math.round((mean - 8) / 10)))
    grayCode = 232 + step
    grayLevel = 8 + step * 10
  }
  const grayDist = (r - grayLevel) ** 2 + (g - grayLevel) ** 2 + (b - grayLevel) ** 2
  return grayDist < cubeDist ? grayCode : cubeCode
}

const DIM = '\x1b[2m'
const UNDIM = '\x1b[22m'

type StyledBlock = { text: string; fg: Color; bg: Color }

function colorSgr(color: Color, isBg: boolean, mode: ColorMode): string {
  if (color.a === 1) return isBg ? '49' : '39'
  if (color.a === 0) {
    const idx = color.r
    if (idx >= 0 && idx <= 7) return String((isBg ? 40 : 30) + idx)
    if (idx >= 8 && idx <= 15) return String((isBg ? 100 : 90) + (idx - 8))
    return `${isBg ? 48 : 38};5;${idx}`
  }
  if (mode === 'truecolor') {
    return `${isBg ? 48 : 38};2;${color.r};${color.g};${color.b}`
  }
  const idx = quantizeToAnsi256(color.r, color.g, color.b)
  return `${isBg ? 48 : 38};5;${idx}`
}

function emitBlocks(
  blocks: StyledBlock[],
  mode: ColorMode,
  dim: boolean,
  skipBackgrounds: boolean,
): string {
  let out = dim ? '\x1b[0m\x1b[2m' : '\x1b[0m'
  let lastFg = '39'
  let lastBg = '49'
  for (const block of blocks) {
    if (block.text === '') continue
    const fg = colorSgr(block.fg, false, mode)
    const bg = skipBackgrounds ? lastBg : colorSgr(block.bg, true, mode)
    const codes: string[] = []
    if (fg !== lastFg) {
      codes.push(fg)
      lastFg = fg
    }
    if (!skipBackgrounds && bg !== lastBg) {
      codes.push(bg)
      lastBg = bg
    }
    if (codes.length > 0) {
      out += `\x1b[${codes.join(';')}m`
    }
    out += block.text
  }
  out += '\x1b[0m'
  return out
}

type DiffTheme = {
  foreground: Color
  background: Color
  addedLineBg: Color
  deletedLineBg: Color
  addedWordBg: Color
  deletedWordBg: Color
  addedDecoration: Color
  deletedDecoration: Color
  scopes: Record<string, Color>
}

const MERCURY_BRAND_DIFF = {
  addedLineBg: rgb(8, 38, 32),
  addedWordBg: rgb(14, 64, 54),
  deletedLineBg: rgb(48, 16, 20),
  deletedWordBg: rgb(80, 26, 32),
  addedDecoration: rgb(63, 191, 160),
  deletedDecoration: rgb(232, 85, 106),
}

const DARK_SCOPES: Record<string, Color> = {
  keyword: rgb(249, 38, 114),
  storage: rgb(102, 217, 239),
  built_in: rgb(102, 217, 239),
  type: rgb(102, 217, 239),
  literal: rgb(174, 129, 255),
  number: rgb(174, 129, 255),
  symbol: rgb(174, 129, 255),
  string: rgb(230, 219, 116),
  regexp: rgb(230, 219, 116),
  'template-variable': rgb(248, 248, 242),
  comment: rgb(117, 113, 94),
  doctag: rgb(117, 113, 94),
  meta: rgb(117, 113, 94),
  title: rgb(166, 226, 46),
  'title.function': rgb(166, 226, 46),
  'title.class': rgb(166, 226, 46),
  function: rgb(166, 226, 46),
  params: rgb(253, 151, 31),
  attr: rgb(166, 226, 46),
  attribute: rgb(166, 226, 46),
  variable: rgb(248, 248, 242),
  'variable.language': rgb(253, 151, 31),
  'variable.constant': rgb(174, 129, 255),
  property: rgb(102, 217, 239),
  operator: rgb(249, 38, 114),
  punctuation: rgb(248, 248, 242),
  tag: rgb(249, 38, 114),
  name: rgb(249, 38, 114),
  'selector-tag': rgb(249, 38, 114),
  'selector-class': rgb(166, 226, 46),
  'selector-id': rgb(166, 226, 46),
  section: rgb(166, 226, 46),
  addition: rgb(166, 226, 46),
  deletion: rgb(249, 38, 114),
}

const LIGHT_SCOPES: Record<string, Color> = {
  keyword: rgb(215, 58, 73),
  storage: rgb(215, 58, 73),
  built_in: rgb(0, 92, 197),
  type: rgb(0, 92, 197),
  literal: rgb(0, 92, 197),
  number: rgb(0, 92, 197),
  symbol: rgb(0, 92, 197),
  string: rgb(3, 47, 98),
  regexp: rgb(3, 47, 98),
  'template-variable': rgb(36, 41, 46),
  comment: rgb(106, 115, 125),
  doctag: rgb(106, 115, 125),
  meta: rgb(106, 115, 125),
  title: rgb(111, 66, 193),
  'title.function': rgb(111, 66, 193),
  'title.class': rgb(111, 66, 193),
  function: rgb(111, 66, 193),
  params: rgb(36, 41, 46),
  attr: rgb(0, 92, 197),
  attribute: rgb(0, 92, 197),
  variable: rgb(227, 98, 9),
  'variable.language': rgb(0, 92, 197),
  'variable.constant': rgb(0, 92, 197),
  property: rgb(0, 92, 197),
  operator: rgb(215, 58, 73),
  punctuation: rgb(36, 41, 46),
  tag: rgb(34, 134, 58),
  name: rgb(34, 134, 58),
  'selector-tag': rgb(34, 134, 58),
  'selector-class': rgb(111, 66, 193),
  'selector-id': rgb(0, 92, 197),
  section: rgb(0, 92, 197),
  addition: rgb(34, 134, 58),
  deletion: rgb(179, 29, 40),
}

const STORAGE_KEYWORDS = new Set([
  'const',
  'let',
  'var',
  'function',
  'class',
  'type',
  'interface',
  'enum',
  'namespace',
  'module',
  'def',
  'fn',
  'func',
  'struct',
  'trait',
  'impl',
])

function buildDiffTheme(themeName: string): DiffTheme {
  const lower = themeName.toLowerCase()
  const isLight =
    lower === 'light' ||
    lower === 'github' ||
    lower.includes('light') ||
    lower.includes('github')
  if (isLight) {
    return {
      foreground: rgb(36, 41, 46),
      background: TERMINAL_DEFAULT,
      addedLineBg: rgb(230, 255, 237),
      deletedLineBg: rgb(255, 238, 240),
      addedWordBg: rgb(172, 242, 189),
      deletedWordBg: rgb(253, 184, 192),
      addedDecoration: rgb(34, 134, 58),
      deletedDecoration: rgb(203, 36, 49),
      scopes: LIGHT_SCOPES,
    }
  }
  const truecolor = detectColorMode() === 'truecolor'
  return {
    foreground: rgb(248, 248, 242),
    background: TERMINAL_DEFAULT,
    addedLineBg: truecolor ? MERCURY_BRAND_DIFF.addedLineBg : paletteIndex(22),
    deletedLineBg: truecolor ? MERCURY_BRAND_DIFF.deletedLineBg : rgb(70, 15, 15),
    addedWordBg: truecolor ? MERCURY_BRAND_DIFF.addedWordBg : paletteIndex(28),
    deletedWordBg: truecolor ? MERCURY_BRAND_DIFF.deletedWordBg : rgb(120, 25, 25),
    addedDecoration: MERCURY_BRAND_DIFF.addedDecoration,
    deletedDecoration: MERCURY_BRAND_DIFF.deletedDecoration,
    scopes: DARK_SCOPES,
  }
}

function colorForScope(scope: string | undefined, text: string, theme: DiffTheme): Color {
  if (!scope) return theme.foreground
  if (scope === 'keyword' && STORAGE_KEYWORDS.has(text.trim())) {
    return theme.scopes.storage ?? theme.scopes.keyword ?? theme.foreground
  }
  const direct = theme.scopes[scope]
  if (direct) return direct
  const dot = scope.indexOf('.')
  if (dot > 0) {
    const head = theme.scopes[scope.slice(0, dot)]
    if (head) return head
  }
  return theme.foreground
}

type HighlightApi = {
  highlight: (code: string, options: { language: string; ignoreIllegals: boolean }) => unknown
  getLanguage: (name: string) => unknown
}

let highlighter: HighlightApi | null = null

function getHighlighter(): HighlightApi {
  if (highlighter) return highlighter
  const loaded = require('highlight.js') as { default?: HighlightApi } & HighlightApi
  highlighter = typeof loaded.highlight === 'function' ? loaded : (loaded.default as HighlightApi)
  return highlighter
}


const FILENAME_LANGUAGES: Record<string, string> = {
  Dockerfile: 'dockerfile',
  Makefile: 'makefile',
  Rakefile: 'ruby',
  Gemfile: 'ruby',
  CMakeLists: 'cmake',
}

const PROSE_LANGUAGES = ['markdown', 'plaintext', 'asciidoc']

export function fileLanguageKind(filePath: string, firstLine?: string): 'prose' | 'code' | 'unknown' {
  const language = detectLanguage(filePath, firstLine)
  if (language === undefined) return 'unknown'
  const hl = getHighlighter()
  const definition = hl.getLanguage(language)
  return PROSE_LANGUAGES.some(name => hl.getLanguage(name) === definition) ? 'prose' : 'code'
}

function detectLanguage(filePath: string, firstLine?: string): string | undefined {
  const hl = getHighlighter()
  const base = filePath.split(/[\\/]/).pop() ?? ''
  const beforeDot = base.split('.')[0] ?? ''
  for (const candidate of [base, beforeDot]) {
    const mapped = FILENAME_LANGUAGES[candidate]
    if (mapped && hl.getLanguage(mapped)) return mapped
  }
  const dot = base.lastIndexOf('.')
  if (dot > 0) {
    const ext = base.slice(dot + 1)
    if (ext && hl.getLanguage(ext)) return ext
  }
  if (firstLine !== undefined) {
    const line = firstLine.replace(/^\uFEFF/, '')
    if (line.startsWith('#!')) {
      if (line.includes('bash') || line.includes('/sh')) return 'bash'
      if (line.includes('python')) return 'python'
      if (line.includes('node')) return 'javascript'
      if (line.includes('ruby')) return 'ruby'
      if (line.includes('perl')) return 'perl'
    }
    if (line.startsWith('<?php')) return 'php'
    if (line.startsWith('<?xml')) return 'xml'
  }
  return undefined
}


type EmitterNode = {
  scope?: string
  kind?: string
  children?: Array<EmitterNode | string>
}

let emitterShapeErrorLogged = false

function highlightLine(line: string, language: string | undefined, theme: DiffTheme): StyledBlock[] {
  const fallback: StyledBlock[] = [{ text: line, fg: theme.foreground, bg: theme.background }]
  if (!language) return fallback
  if (shouldSkipHighlight(line)) return fallback
  let result: unknown
  try {
    result = getHighlighter().highlight(`${line}\n`, { language, ignoreIllegals: true })
  } catch {
    return fallback
  }
  const emitter =
    (result as { _emitter?: unknown })._emitter ?? (result as { emitter?: unknown }).emitter
  const root =
    typeof emitter === 'object' && emitter !== null
      ? ((emitter as { rootNode?: unknown; root?: unknown }).rootNode ??
        (emitter as { root?: unknown }).root)
      : undefined
  const rootOk =
    typeof root === 'object' &&
    root !== null &&
    Array.isArray((root as { children?: unknown }).children)
  if (!rootOk) {
    if (!emitterShapeErrorLogged) {
      emitterShapeErrorLogged = true
      const keys =
        typeof emitter === 'object' && emitter !== null
          ? Object.keys(emitter).join(', ')
          : String(emitter)
      logError(
        `color-diff: highlighter emitter shape mismatched (keys: ${keys}); syntax highlighting is disabled`,
      )
    }
    return fallback
  }
  const blocks: StyledBlock[] = []
  const visit = (node: EmitterNode | string, scope: string | undefined): void => {
    if (typeof node === 'string') {
      if (node !== '') {
        blocks.push({ text: node, fg: colorForScope(scope, node, theme), bg: theme.background })
      }
      return
    }
    const ownScope = node.scope ?? node.kind ?? scope
    for (const child of node.children ?? []) visit(child, ownScope)
  }
  for (const child of (root as EmitterNode).children ?? []) visit(child, undefined)
  return blocks.length > 0 ? blocks : fallback
}


const WORD_CHAR = /[\p{L}\p{Nd}_]/u
const WHITESPACE = /\s/

function tokenize(text: string): string[] {
  const tokens: string[] = []
  let current = ''
  let kind: 'word' | 'space' | null = null
  for (const ch of text) {
    if (WORD_CHAR.test(ch)) {
      if (kind === 'word') {
        current += ch
      } else {
        if (current !== '') tokens.push(current)
        current = ch
        kind = 'word'
      }
    } else if (WHITESPACE.test(ch)) {
      if (kind === 'space') {
        current += ch
      } else {
        if (current !== '') tokens.push(current)
        current = ch
        kind = 'space'
      }
    } else {
      if (current !== '') {
        tokens.push(current)
        current = ''
        kind = null
      }
      tokens.push(ch)
    }
  }
  if (current !== '') tokens.push(current)
  return tokens
}

type CharRange = { start: number; end: number }

const WORD_DIFF_THRESHOLD = 0.4

function wordDiff(oldText: string, newText: string): { removed: CharRange[]; added: CharRange[] } {
  const parts = diffArrays(tokenize(oldText), tokenize(newText))
  const removed: CharRange[] = []
  const added: CharRange[] = []
  let oldOffset = 0
  let newOffset = 0
  let changed = 0
  for (const part of parts) {
    const length = part.value.reduce((n, token) => n + token.length, 0)
    if (part.removed) {
      removed.push({ start: oldOffset, end: oldOffset + length })
      oldOffset += length
      changed += length
    } else if (part.added) {
      added.push({ start: newOffset, end: newOffset + length })
      newOffset += length
      changed += length
    } else {
      oldOffset += length
      newOffset += length
    }
  }
  if (changed / Math.max(1, oldText.length + newText.length) > WORD_DIFF_THRESHOLD) {
    return { removed: [], added: [] }
  }
  return { removed, added }
}

function pairChangedLines(markers: string[]): Array<{ deleted: number; added: number }> {
  const pairs: Array<{ deleted: number; added: number }> = []
  let i = 0
  while (i < markers.length) {
    if (markers[i] !== '-') {
      i++
      continue
    }
    let deletedEnd = i
    while (deletedEnd < markers.length && markers[deletedEnd] === '-') deletedEnd++
    let addedEnd = deletedEnd
    while (addedEnd < markers.length && markers[addedEnd] === '+') addedEnd++
    const deletedCount = deletedEnd - i
    const addedCount = addedEnd - deletedEnd
    if (addedCount > 0) {
      for (let k = 0; k < Math.min(deletedCount, addedCount); k++) {
        pairs.push({ deleted: i + k, added: deletedEnd + k })
      }
      i = addedEnd
    } else {
      i = deletedEnd
    }
  }
  return pairs
}


function removeNewlines(blocks: StyledBlock[]): StyledBlock[] {
  const out: StyledBlock[] = []
  for (const block of blocks) {
    for (const fragment of block.text.split('\n')) {
      if (fragment !== '') out.push({ ...block, text: fragment })
    }
  }
  return out
}

function applyBackgrounds(
  blocks: StyledBlock[],
  marker: string | null,
  ranges: CharRange[],
  lineBg: Color,
  wordBg: Color,
): StyledBlock[] {
  if ((marker !== '+' && marker !== '-') || ranges.length === 0) {
    return blocks.map(block => ({ ...block, bg: lineBg }))
  }
  const out: StyledBlock[] = []
  let offset = 0
  let rangeIdx = 0
  for (const block of blocks) {
    const blockStart = offset
    const blockEnd = offset + block.text.length
    let pos = blockStart
    while (rangeIdx < ranges.length && ranges[rangeIdx]!.end <= blockStart) {
      rangeIdx++
    }
    let idx = rangeIdx
    while (idx < ranges.length && ranges[idx]!.start < blockEnd) {
      const range = ranges[idx]!
      if (range.start > pos) {
        out.push({
          ...block,
          text: block.text.slice(pos - blockStart, range.start - blockStart),
          bg: lineBg,
        })
        pos = range.start
      }
      const segEnd = Math.min(blockEnd, range.end)
      if (segEnd > pos) {
        out.push({
          ...block,
          text: block.text.slice(pos - blockStart, segEnd - blockStart),
          bg: wordBg,
        })
        pos = segEnd
      }
      if (range.end <= blockEnd) {
        idx++
      } else {
        break
      }
    }
    if (pos < blockEnd) {
      out.push({
        ...block,
        text: block.text.slice(pos - blockStart),
        bg: lineBg,
      })
    }
    offset = blockEnd
  }
  return out
}

function wrapBlocks(blocks: StyledBlock[], width: number): StyledBlock[][] {
  const maxWidth = Math.max(1, width)
  const rows: StyledBlock[][] = []
  let currentRow: StyledBlock[] = []
  let currentWidth = 0

  for (const block of blocks) {
    if (block.text === '') continue
    const blockWidth = stringWidth(block.text)
    if (currentWidth + blockWidth <= maxWidth) {
      currentRow.push(block)
      currentWidth += blockWidth
      continue
    }
    let chunk = ''
    for (const ch of block.text) {
      const w = charWidth(ch)
      if (currentWidth + w > maxWidth && (currentWidth > 0 || chunk !== '')) {
        if (chunk !== '') {
          currentRow.push({ ...block, text: chunk })
          chunk = ''
        }
        rows.push(currentRow)
        currentRow = []
        currentWidth = 0
      }
      chunk += ch
      currentWidth += w
    }
    if (chunk !== '') {
      currentRow.push({ ...block, text: chunk })
    }
  }

  if (currentRow.length > 0 || rows.length === 0) {
    rows.push(currentRow)
  }
  return rows
}


type Hunk = {
  oldStart: number
  oldLines: number
  newStart: number
  newLines: number
  lines: string[]
}

type RenderLine = { marker: string | null; lineNumber: number | null; code: string }

function renderLines(
  lines: RenderLine[],
  themeName: string,
  width: number,
  dim: boolean,
  filePath: string,
  firstLine: string | undefined,
  gutterWidth: number,
  hasMarkers: boolean,
  wordRanges: Map<number, CharRange[]>,
): string[] {
  const mode = detectColorMode()
  const theme = buildDiffTheme(themeName)
  const language = detectLanguage(filePath, firstLine)
  const effectiveWidth = Math.max(1, width - gutterWidth - 2 - (hasMarkers ? 1 : 0))
  const out: string[] = []

  lines.forEach((line, index) => {
    let blocks: StyledBlock[] =
      line.marker === '-'
        ? [{ text: line.code, fg: theme.foreground, bg: theme.background }]
        : highlightLine(line.code, language, theme)
    blocks = removeNewlines(blocks)

    const lineBg =
      line.marker === '+'
        ? theme.addedLineBg
        : line.marker === '-'
          ? theme.deletedLineBg
          : theme.background
    const wordBg =
      line.marker === '+'
        ? theme.addedWordBg
        : line.marker === '-'
          ? theme.deletedWordBg
          : theme.background
    blocks = applyBackgrounds(blocks, line.marker, wordRanges.get(index) ?? [], lineBg, wordBg)

    let rows = wrapBlocks(blocks, effectiveWidth)

    if (line.marker === '+' || line.marker === '-') {
      rows = rows.map(row => {
        const rowWidth = row.reduce((n, block) => n + stringWidth(block.text), 0)
        if (rowWidth < effectiveWidth) {
          return [...row, { text: ' '.repeat(effectiveWidth - rowWidth), fg: theme.foreground, bg: lineBg }]
        }
        return row
      })
    }

    const decoration =
      line.marker === '+'
        ? theme.addedDecoration
        : line.marker === '-'
          ? theme.deletedDecoration
          : theme.foreground

    rows.forEach((row, rowIndex) => {
      const withMarker: StyledBlock[] = hasMarkers
        ? [
            {
              text: line.marker === null ? ' ' : line.marker === ' ' ? ' ' : line.marker,
              fg: line.marker === '+' || line.marker === '-' ? decoration : theme.foreground,
              bg: line.marker === '+' || line.marker === '-' ? lineBg : theme.background,
            },
            ...row,
          ]
        : row
      const numberText =
        rowIndex === 0 && line.lineNumber !== null
          ? ` ${String(line.lineNumber).padStart(gutterWidth)} `
          : ' '.repeat(gutterWidth + 2)
      const marked = line.marker === '+' || line.marker === '-'
      let gutter: StyledBlock = {
        text: numberText,
        fg: marked ? decoration : theme.foreground,
        bg: marked ? lineBg : theme.background,
      }
      if (!marked && !dim) {
        gutter = { ...gutter, text: `${DIM}${gutter.text}${UNDIM}` }
      }
      out.push(emitBlocks([gutter, ...withMarker], mode, dim, !hasMarkers))
    })
  })
  return out
}

export class ColorDiff {
  private hunk: Hunk
  private firstLine: string | undefined
  private filePath: string

  constructor(hunk: Hunk, firstLine?: string, filePath?: string, _prefixContent?: string) {
    this.hunk = hunk
    this.firstLine = firstLine
    this.filePath = filePath ?? ''
  }

  render(themeName: string, width: number, dim: boolean): string[] | null {
    const maxLine = Math.max(
      1,
      this.hunk.oldStart + this.hunk.oldLines - 1,
      this.hunk.newStart + this.hunk.newLines - 1,
    )
    const gutterWidth = String(maxLine).length
    let oldLine = this.hunk.oldStart
    let newLine = this.hunk.newStart
    const lines: RenderLine[] = []
    for (const rawLine of this.hunk.lines) {
      if (rawLine.startsWith('+')) {
        lines.push({ marker: '+', lineNumber: newLine++, code: expandTabs(rawLine.slice(1)) })
      } else if (rawLine.startsWith('-')) {
        lines.push({ marker: '-', lineNumber: oldLine++, code: expandTabs(rawLine.slice(1)) })
      } else if (rawLine.startsWith(' ')) {
        lines.push({ marker: ' ', lineNumber: newLine++, code: expandTabs(rawLine.slice(1)) })
        oldLine++
      } else {
        lines.push({ marker: null, lineNumber: null, code: expandTabs(rawLine) })
      }
    }
    const wordRanges = new Map<number, CharRange[]>()
    if (!dim) {
      const markers = lines.map(line => line.marker ?? ' ')
      for (const pair of pairChangedLines(markers)) {
        const { removed, added } = wordDiff(lines[pair.deleted]!.code, lines[pair.added]!.code)
        if (removed.length > 0) wordRanges.set(pair.deleted, removed)
        if (added.length > 0) wordRanges.set(pair.added, added)
      }
    }
    return renderLines(
      lines,
      themeName,
      width,
      dim,
      this.filePath,
      this.firstLine ?? lines[0]?.code,
      gutterWidth,
      true,
      wordRanges,
    )
  }
}

export class ColorFile {
  private source: string
  private filePath: string

  constructor(source: string, filePath: string) {
    this.source = source
    this.filePath = filePath
  }

  render(themeName: string, width: number, dim: boolean): string[] | null {
    const split = expandTabs(this.source).split('\n')
    if (split.length > 0 && split[split.length - 1] === '') split.pop()
    const gutterWidth = String(split.length).length
    const lines: RenderLine[] = split.map((code, index) => ({
      marker: null,
      lineNumber: index + 1,
      code,
    }))
    return renderLines(
      lines,
      themeName,
      width,
      dim,
      this.filePath,
      split[0],
      gutterWidth,
      false,
      new Map(),
    )
  }
}

export type SyntaxTheme = { theme: string; source: string | null }

export function getSyntaxTheme(uiTheme: string): SyntaxTheme {
  const theme =
    uiTheme === 'dark' || uiTheme === 'true-black' ? 'Monokai Extended' : 'GitHub'
  return { theme, source: null }
}

export const __test = {
  tokenize,
  pairChangedLines,
  wordDiff,
  quantizeToAnsi256,
  emitBlocks,
  detectLanguage,
}
