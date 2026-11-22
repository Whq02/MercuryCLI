import { shouldSkipHighlight } from '../../utils/cliHighlight.js'
import { diffArrays } from 'diff'
import { truecolorActive } from '../../ink/colorize.js'
import { stringWidth } from '../../ink/stringWidth.js'
import { expandTabs } from '../../ink/tabstops.js'
import { logError } from '../../utils/log.js'
import { notBuilt, unbuilt, type Unbuilt } from '../../pi/holes.js'

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

function quantizeToAnsi256(r: number, g: number, b: number): number {
  return notBuilt('src/native-ts/color-diff/index.ts:43')
}
const DIM: Unbuilt = unbuilt('src/native-ts/color-diff/index.ts:87')
const UNDIM: Unbuilt = unbuilt('src/native-ts/color-diff/index.ts:88')

type StyledBlock = Unbuilt

function emitBlocks(
  blocks: StyledBlock[],
  mode: ColorMode,
  dim: boolean,
  skipBackgrounds: boolean,
): string {
  return notBuilt('src/native-ts/color-diff/index.ts:92')
}


type DiffTheme = Unbuilt

function buildDiffTheme(themeName: string): DiffTheme {
  return notBuilt('src/native-ts/color-diff/index.ts:181')
}

function colorForScope(scope: string | undefined, text: string, theme: DiffTheme): Color {
  return notBuilt('src/native-ts/color-diff/index.ts:229')
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
  return notBuilt('src/native-ts/color-diff/index.ts:364')
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
  return notBuilt('src/native-ts/color-diff/index.ts:465')
}

function wrapBlocks(blocks: StyledBlock[], width: number): StyledBlock[][] {
  return notBuilt('src/native-ts/color-diff/index.ts:509')
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
    notBuilt('src/native-ts/color-diff/index.ts:661')
  }

  render(themeName: string, width: number, dim: boolean): string[] | null {
    return notBuilt('src/native-ts/color-diff/index.ts:667')
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
