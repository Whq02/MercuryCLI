// ============================================================================
//  src/native-ts/color-diff/index.ts — syntax-highlighted diff/file
//  rendering, replacing the vendored native module with its declared API
//  kept exactly (callers unchanged; reached through the `color-diff-napi`
//  build alias).
//
//  Known semantic differences (deliberate): highlighting rides a JS
//  highlighter, so unscoped tokens (plain identifiers, `=`/`:` operators)
//  render in the default foreground; output STRUCTURE — numbers, markers,
//  backgrounds, word-diff bands — is identical. External theme selection
//  via environment variables is a stub (no alternative theme set exists).
// ============================================================================
import { shouldSkipHighlight } from '../../utils/cliHighlight.js'
import { diffArrays } from 'diff'
import { flagEnv } from '../../substrate/flagRegistry.js'
import { stringWidth } from '../../ink/stringWidth.js'
import { isEnvTruthy } from '../../utils/envUtils.js'
import { logError } from '../../utils/log.js'

// The sanctioned local width primitive: a one-line forwarder to the UI's
// display-width oracle (kept local rather than importing the components
// tree; update this copy if the oracle's contract changes).
function charWidth(char: string): number {
  return stringWidth(char)
}

// ── colour model ───────────────────────────────────────────────────────────
// RGBA quadruples with two sentinel encodings: alpha 0 = palette index in
// the red channel; alpha 1 = terminal default; otherwise literal 24-bit.

type Color = { r: number; g: number; b: number; a: number }

function rgb(r: number, g: number, b: number): Color {
  return { r, g, b, a: 255 }
}

function paletteIndex(index: number): Color {
  return { r: index, g: 0, b: 0, a: 0 }
}

const TERMINAL_DEFAULT: Color = { r: 0, g: 0, b: 0, a: 1 }

type ColorMode = 'ansi' | 'truecolor' | 'color256'

/**
 * Colour-mode detection. Mirrors the terminal layer's truecolor boost (so
 * the brand palette emits exact 24-bit values even when the terminal does
 * not advertise support) and its multiplexer clamp (a multiplexer only
 * re-emits 24-bit sequences when explicitly configured — otherwise the
 * diff spine renders black on dark).
 */
function detectColorMode(themeName: string): ColorMode {
  if (themeName.includes('ansi')) return 'ansi'
  // An explicitly truthy MERCURY_TRUECOLOR lifts the multiplexer clamp (the
  // configured-tmux escape — one spelling, no compat alias).
  const inMultiplexer =
    process.env.TMUX !== undefined && !isEnvTruthy(flagEnv('MERCURY_TRUECOLOR'))
  if (flagEnv('MERCURY_TRUECOLOR') !== '0' && !inMultiplexer) return 'truecolor'
  const colorterm = process.env.COLORTERM
  if (colorterm === 'truecolor' || colorterm === '24bit') return 'truecolor'
  return 'color256'
}

// ── RGB→256 quantisation (reproduces the reference crate) ──────────────────

const CHANNEL_THRESHOLDS = [48, 115, 155, 195, 235]
const CUBE_LEVELS = [0, 95, 135, 175, 215, 255]

function quantizeChannel(value: number): number {
  let level = 0
  for (const threshold of CHANNEL_THRESHOLDS) {
    if (value >= threshold) level++
  }
  return level
}

function quantizeToAnsi256(r: number, g: number, b: number): number {
  const qr = quantizeChannel(r)
  const qg = quantizeChannel(g)
  const qb = quantizeChannel(b)
  const cubeIndex = 16 + 36 * qr + 6 * qg + qb
  const mean = (r + g + b) / 3
  if (mean < 5) return 16
  // Near-white with equal quantised channels snaps to CUBE white, not the
  // grey-ramp top (the reference crate's behaviour).
  if (mean > 244 && qr === qg && qg === qb) return cubeIndex
  const greyLevel = Math.min(23, Math.max(0, Math.round((mean - 8) / 10)))
  const greyValue = 8 + greyLevel * 10
  const cubeR = CUBE_LEVELS[qr]!
  const cubeG = CUBE_LEVELS[qg]!
  const cubeB = CUBE_LEVELS[qb]!
  const greyDist = (r - greyValue) ** 2 + (g - greyValue) ** 2 + (b - greyValue) ** 2
  const cubeDist = (r - cubeR) ** 2 + (g - cubeG) ** 2 + (b - cubeB) ** 2
  return cubeDist <= greyDist ? cubeIndex : 232 + greyLevel
}

// ── escape emission ────────────────────────────────────────────────────────

function fgEscape(color: Color, mode: ColorMode): string {
  if (color.a === 0) {
    const index = color.r
    if (index < 8) return `\x1b[${30 + index}m`
    if (index < 16) return `\x1b[${90 + (index - 8)}m`
    return `\x1b[38;5;${index}m`
  }
  if (color.a === 1) return '\x1b[39m'
  if (mode === 'truecolor') return `\x1b[38;2;${color.r};${color.g};${color.b}m`
  return `\x1b[38;5;${quantizeToAnsi256(color.r, color.g, color.b)}m`
}

function bgEscape(color: Color, mode: ColorMode): string {
  if (color.a === 0) {
    const index = color.r
    if (index < 8) return `\x1b[${40 + index}m`
    if (index < 16) return `\x1b[${100 + (index - 8)}m`
    return `\x1b[48;5;${index}m`
  }
  if (color.a === 1) return '\x1b[49m'
  if (mode === 'truecolor') return `\x1b[48;2;${color.r};${color.g};${color.b}m`
  return `\x1b[48;5;${quantizeToAnsi256(color.r, color.g, color.b)}m`
}

const RESET = '\x1b[0m'
const DIM = '\x1b[2m'
const UNDIM = '\x1b[22m'

type StyledBlock = { text: string; fg: Color; bg: Color }

/** Reset (plus dim when dimming), per-block fg + bg + text, final reset. */
function emitBlocks(
  blocks: StyledBlock[],
  mode: ColorMode,
  dim: boolean,
  skipBackgrounds: boolean,
): string {
  let out = RESET + (dim ? DIM : '')
  for (const block of blocks) {
    out += fgEscape(block.fg, mode)
    if (!skipBackgrounds) out += bgEscape(block.bg, mode)
    out += block.text
  }
  return out + RESET
}

// ── themes ─────────────────────────────────────────────────────────────────

type DiffTheme = {
  addedLineBg: Color
  addedWordBg: Color
  addedDecoration: Color
  deletedLineBg: Color
  deletedWordBg: Color
  deletedDecoration: Color
  foreground: Color
  background: Color
  scopes: Record<string, Color>
}

// Scope maps (contract data — measured from the reference renderer).
const DARK_SCOPES: Record<string, Color> = {
  keyword: rgb(249, 38, 114),
  storage: rgb(102, 217, 239),
  'built_in': rgb(166, 226, 46),
  type: rgb(166, 226, 46),
  literal: rgb(190, 132, 255),
  number: rgb(190, 132, 255),
  string: rgb(230, 219, 116),
  title: rgb(166, 226, 46),
  'title.function': rgb(166, 226, 46),
  'title.class': rgb(166, 226, 46),
  'title.class.inherited': rgb(166, 226, 46),
  params: rgb(253, 151, 31),
  comment: rgb(117, 113, 94),
  meta: rgb(117, 113, 94),
  attr: rgb(166, 226, 46),
  attribute: rgb(166, 226, 46),
  variable: rgb(255, 255, 255),
  'variable.language': rgb(255, 255, 255),
  property: rgb(255, 255, 255),
  operator: rgb(249, 38, 114),
  punctuation: rgb(248, 248, 242),
  symbol: rgb(190, 132, 255),
  regexp: rgb(230, 219, 116),
  subst: rgb(248, 248, 242),
}

const LIGHT_SCOPES: Record<string, Color> = {
  keyword: rgb(167, 29, 93),
  storage: rgb(167, 29, 93),
  'built_in': rgb(0, 134, 179),
  type: rgb(0, 134, 179),
  literal: rgb(0, 134, 179),
  number: rgb(0, 134, 179),
  string: rgb(24, 54, 145),
  title: rgb(121, 93, 163),
  'title.function': rgb(121, 93, 163),
  'title.class': rgb(0, 0, 0),
  'title.class.inherited': rgb(0, 0, 0),
  params: rgb(0, 134, 179),
  comment: rgb(150, 152, 150),
  meta: rgb(150, 152, 150),
  attr: rgb(0, 134, 179),
  attribute: rgb(0, 134, 179),
  variable: rgb(0, 134, 179),
  'variable.language': rgb(0, 134, 179),
  property: rgb(0, 134, 179),
  operator: rgb(167, 29, 93),
  punctuation: rgb(51, 51, 51),
  symbol: rgb(0, 134, 179),
  regexp: rgb(24, 54, 145),
  subst: rgb(51, 51, 51),
}

// Deliberately a STRICT SUBSET (ten entries): unlisted scopes fall through
// to the theme foreground. Do not "complete" it.
const ANSI_SCOPES: Record<string, Color> = {
  keyword: paletteIndex(13),
  storage: paletteIndex(14),
  'built_in': paletteIndex(14),
  type: paletteIndex(14),
  literal: paletteIndex(12),
  number: paletteIndex(12),
  string: paletteIndex(10),
  title: paletteIndex(11),
  'title.function': paletteIndex(11),
  'title.class': paletteIndex(11),
  comment: paletteIndex(8),
  meta: paletteIndex(8),
}

/**
 * The Mercury brand diff palette — the SAME scope as the warm-ink theme
 * overlay: the default dark theme and the operator brand theme, true
 * colour only, never the accessibility paths. The `name: rgb(r, g, b)`
 * spellings below are pinned by prove-diff-spine against the palette
 * module's diff tint constants.
 */
const MERCURY_BRAND_DIFF = {
  addLine: rgb(8, 38, 32),
  addWord: rgb(14, 64, 54),
  deleteLine: rgb(48, 16, 20),
  deleteWord: rgb(80, 26, 32),
}

function buildDiffTheme(themeName: string): DiffTheme {
  const mode = detectColorMode(themeName)
  const isAnsi = themeName.includes('ansi')
  const isDaltonized = themeName.includes('daltonized')
  // The dark-ground names: the dark family, the true-black appearance
  // (same brand spine on the pure-black ground), and the operator brand.
  const isDarkish =
    themeName.includes('dark') ||
    themeName.includes('black')

  if (mode === 'truecolor' && !isAnsi && !isDaltonized && isDarkish) {
    return {
      addedLineBg: MERCURY_BRAND_DIFF.addLine,
      addedWordBg: MERCURY_BRAND_DIFF.addWord,
      addedDecoration: rgb(63, 191, 160),
      deletedLineBg: MERCURY_BRAND_DIFF.deleteLine,
      deletedWordBg: MERCURY_BRAND_DIFF.deleteWord,
      deletedDecoration: rgb(232, 85, 106),
      foreground: rgb(237, 232, 221),
      background: TERMINAL_DEFAULT,
      scopes: DARK_SCOPES,
    }
  }
  if (isAnsi) {
    return {
      addedLineBg: TERMINAL_DEFAULT,
      addedWordBg: TERMINAL_DEFAULT,
      addedDecoration: paletteIndex(10),
      deletedLineBg: TERMINAL_DEFAULT,
      deletedWordBg: TERMINAL_DEFAULT,
      deletedDecoration: paletteIndex(9),
      foreground: paletteIndex(7),
      background: TERMINAL_DEFAULT,
      scopes: ANSI_SCOPES,
    }
  }
  if (themeName.includes('dark') || themeName.includes('black')) {
    const truecolor = mode === 'truecolor'
    return {
      addedLineBg: isDaltonized
        ? truecolor
          ? rgb(0, 27, 41)
          : paletteIndex(17)
        : truecolor
          ? rgb(2, 40, 0)
          : paletteIndex(22),
      addedWordBg: isDaltonized
        ? truecolor
          ? rgb(0, 48, 71)
          : paletteIndex(24)
        : truecolor
          ? rgb(4, 71, 0)
          : paletteIndex(28),
      addedDecoration: isDaltonized ? rgb(81, 160, 200) : rgb(80, 200, 80),
      deletedLineBg: rgb(61, 1, 0),
      deletedWordBg: rgb(92, 2, 0),
      deletedDecoration: rgb(220, 90, 90),
      foreground: rgb(248, 248, 242),
      background: TERMINAL_DEFAULT,
      scopes: DARK_SCOPES,
    }
  }
  return {
    addedLineBg: isDaltonized ? rgb(219, 237, 255) : rgb(220, 255, 220),
    addedWordBg: isDaltonized ? rgb(179, 217, 255) : rgb(178, 255, 178),
    addedDecoration: isDaltonized ? rgb(36, 87, 138) : rgb(36, 138, 61),
    deletedLineBg: rgb(255, 220, 220),
    deletedWordBg: rgb(255, 199, 199),
    deletedDecoration: rgb(207, 34, 46),
    foreground: rgb(51, 51, 51),
    background: TERMINAL_DEFAULT,
    scopes: LIGHT_SCOPES,
  }
}

// The storage split: the reference grammar scopes declaration keywords as
// storage while the JS highlighter lumps them under "keyword" (contract
// data — matched against the trimmed token text).
const STORAGE_KEYWORDS = new Set([
  'const', 'let', 'var', 'function', 'class', 'type', 'interface', 'enum',
  'namespace', 'module', 'def', 'fn', 'func', 'struct', 'trait', 'impl',
])

function colorForScope(scope: string | undefined, text: string, theme: DiffTheme): Color {
  if (scope === undefined) return theme.foreground
  if (scope === 'keyword' && STORAGE_KEYWORDS.has(text.trim())) {
    return theme.scopes['storage'] ?? theme.foreground
  }
  const exact = theme.scopes[scope]
  if (exact) return exact
  const segment = scope.split('.')[0]!
  return theme.scopes[segment] ?? theme.foreground
}

// ── lazy highlighter ───────────────────────────────────────────────────────
// Loading registers 190+ grammars (~50 MB, 100-200 ms on macOS, several
// times that on Windows) — first render, never module evaluation.

type HighlightApi = {
  highlight: (code: string, options: { language: string; ignoreIllegals: boolean }) => unknown
  getLanguage: (name: string) => unknown
}

let highlighter: HighlightApi | null = null

function getHighlighter(): HighlightApi {
  if (highlighter) return highlighter
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const loaded = require('highlight.js') as { default?: HighlightApi } & HighlightApi
  // Tolerate both interop shapes: a default-wrapped CommonJS module or the
  // API exposed directly.
  highlighter = typeof loaded.highlight === 'function' ? loaded : (loaded.default as HighlightApi)
  return highlighter
}

// ── language detection ─────────────────────────────────────────────────────

const FILENAME_LANGUAGES: Record<string, string> = {
  Dockerfile: 'dockerfile',
  Makefile: 'makefile',
  Rakefile: 'ruby',
  Gemfile: 'ruby',
  CMakeLists: 'cmake',
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

// ── per-line highlighting ──────────────────────────────────────────────────

type EmitterNode = {
  scope?: string
  kind?: string
  children?: Array<EmitterNode | string>
}

let emitterShapeErrorLogged = false

function highlightLine(line: string, language: string | undefined, theme: DiffTheme): StyledBlock[] {
  const fallback: StyledBlock[] = [{ text: line, fg: theme.foreground, bg: theme.background }]
  if (!language) return fallback
  // The pathological-line guard (sweep #2, A1.3): a minified line
  // paints plain rather than stalling the diff.
  if (shouldSkipHighlight(line)) return fallback
  let result: unknown
  try {
    // Trailing newline so line comments terminate as in a multi-line
    // document (stripped again by the newline-removal pass).
    result = getHighlighter().highlight(`${line}\n`, { language, ignoreIllegals: true })
  } catch {
    return fallback
  }
  const emitter =
    (result as { _emitter?: unknown })._emitter ?? (result as { emitter?: unknown }).emitter
  // Explicit shape validation — never a silent cast. The predecessor's
  // silent cast hid a version mismatch behind a grey fallback.
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

// ── word diff ──────────────────────────────────────────────────────────────

const WORD_CHAR = /[\p{L}\p{Nd}_]/u
const WHITESPACE = /\s/

/** Runs of letters/digits/underscore, runs of whitespace, and single code
 *  points otherwise (surrogate pairs advance as one token). */
function tokenize(text: string): string[] {
  const tokens: string[] = []
  let i = 0
  while (i < text.length) {
    const cp = text.codePointAt(i)!
    const char = String.fromCodePoint(cp)
    if (WORD_CHAR.test(char)) {
      let j = i
      while (j < text.length) {
        const c = String.fromCodePoint(text.codePointAt(j)!)
        if (!WORD_CHAR.test(c)) break
        j += c.length
      }
      tokens.push(text.slice(i, j))
      i = j
    } else if (WHITESPACE.test(char)) {
      let j = i
      while (j < text.length) {
        const c = String.fromCodePoint(text.codePointAt(j)!)
        if (!WHITESPACE.test(c)) break
        j += c.length
      }
      tokens.push(text.slice(i, j))
      i = j
    } else {
      tokens.push(char)
      i += char.length
    }
  }
  return tokens
}

type CharRange = { start: number; end: number }

const WORD_DIFF_THRESHOLD = 0.4

/** Ranges are STRING offsets. Past the 0.4 changed-fraction threshold both
 *  lists come back empty — the lines are too different to help. */
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

/** Pair each run of deletions with the immediately following run of adds,
 *  positionally, up to the shorter length. */
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

// ── transform passes ───────────────────────────────────────────────────────

/** Split each block's text on newlines, dropping empty fragments. */
function removeNewlines(blocks: StyledBlock[]): StyledBlock[] {
  const out: StyledBlock[] = []
  for (const block of blocks) {
    for (const fragment of block.text.split('\n')) {
      if (fragment !== '') out.push({ ...block, text: fragment })
    }
  }
  return out
}

/**
 * Apply word-diff/line backgrounds. Early return on a NULL marker only
 * (file rendering); a context line IS processed — both its backgrounds
 * resolve to the theme background, a no-op in effect but not in object
 * identity. Do not add a context short-circuit.
 */
function applyBackgrounds(
  blocks: StyledBlock[],
  marker: string | null,
  ranges: CharRange[],
  lineBg: Color,
  wordBg: Color,
): StyledBlock[] {
  if (marker === null) return blocks
  const out: StyledBlock[] = []
  let offset = 0
  let rangeIndex = 0
  for (const block of blocks) {
    const blockStart = offset
    const blockEnd = offset + block.text.length
    offset = blockEnd
    while (rangeIndex < ranges.length && ranges[rangeIndex]!.end <= blockStart) rangeIndex++
    if (rangeIndex >= ranges.length) {
      out.push({ ...block, bg: lineBg })
      continue
    }
    let cursor = blockStart
    let localRange = rangeIndex
    while (cursor < blockEnd && localRange < ranges.length) {
      const range = ranges[localRange]!
      if (range.start > cursor) {
        const end = Math.min(range.start, blockEnd)
        out.push({ ...block, text: block.text.slice(cursor - blockStart, end - blockStart), bg: lineBg })
        cursor = end
        if (cursor >= blockEnd) break
      }
      if (cursor < blockEnd && range.end > cursor) {
        const end = Math.min(range.end, blockEnd)
        out.push({ ...block, text: block.text.slice(cursor - blockStart, end - blockStart), bg: wordBg })
        cursor = end
      }
      if (range.end <= cursor) localRange++
    }
    if (cursor < blockEnd) {
      out.push({ ...block, text: block.text.slice(cursor - blockStart), bg: lineBg })
    }
  }
  return out
}

/**
 * Display-width wrapping over a block queue. Mandatory edge cases: nothing
 * fits + empty line → force ONE code point through (overflow beats an
 * infinite loop); nothing fits + line has content → flush and re-queue the
 * whole block.
 */
function wrapBlocks(blocks: StyledBlock[], width: number): StyledBlock[][] {
  const rows: StyledBlock[][] = []
  let current: StyledBlock[] = []
  let currentWidth = 0
  const queue = [...blocks]
  while (queue.length > 0) {
    const block = queue.shift()!
    const blockWidth = stringWidth(block.text)
    if (currentWidth + blockWidth <= width) {
      current.push(block)
      currentWidth += blockWidth
      continue
    }
    // Split at the last code point that still fits.
    let fit = ''
    let fitWidth = 0
    for (const char of block.text) {
      const w = charWidth(char)
      if (fitWidth + w > width - currentWidth) break
      fit += char
      fitWidth += w
    }
    if (fit === '') {
      if (current.length === 0) {
        // Force one code point through for progress.
        const first = [...block.text][0] ?? ''
        current.push({ ...block, text: first })
        rows.push(current)
        current = []
        currentWidth = 0
        const rest = block.text.slice(first.length)
        if (rest !== '') queue.unshift({ ...block, text: rest })
      } else {
        rows.push(current)
        current = []
        currentWidth = 0
        queue.unshift(block)
      }
      continue
    }
    current.push({ ...block, text: fit })
    rows.push(current)
    current = []
    currentWidth = 0
    const rest = block.text.slice(fit.length)
    if (rest !== '') queue.unshift({ ...block, text: rest })
  }
  rows.push(current)
  return rows
}

// ── the public classes ─────────────────────────────────────────────────────

export type Hunk = {
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
  const mode = detectColorMode(themeName)
  const theme = buildDiffTheme(themeName)
  const language = detectLanguage(filePath, firstLine)
  const effectiveWidth = Math.max(1, width - gutterWidth - 2 - (hasMarkers ? 1 : 0))
  const out: string[] = []

  lines.forEach((line, index) => {
    // Deleted content is never syntax-highlighted.
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

    // Pad changed lines to the full width so the row background reaches
    // the edge.
    if (line.marker === '+' || line.marker === '-') {
      rows = rows.map(row => {
        const rowWidth = row.reduce((n, block) => n + stringWidth(block.text), 0)
        if (rowWidth < effectiveWidth) {
          return [...row, { text: ' '.repeat(effectiveWidth - rowWidth), fg: theme.foreground, bg: lineBg }]
        }
        return row
      })
    }

    // ANSI deletions dim their content.
    if (mode === 'ansi' && line.marker === '-') {
      rows = rows.map(row => {
        if (row.length === 0) return row
        const first = { ...row[0]!, text: DIM + row[0]!.text }
        const last =
          row.length === 1
            ? { ...first, text: `${first.text}${UNDIM}` }
            : { ...row[row.length - 1]!, text: row[row.length - 1]!.text + UNDIM }
        return row.length === 1 ? [last] : [first, ...row.slice(1, -1), last]
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
      // A context/unmarked gutter is dim-wrapped unless the whole render
      // is already dimmed.
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
    // The prefix-content argument exists for API parity (the reference
    // warmed a stateful highlighter); the JS highlighter is stateless.
    this.hunk = hunk
    this.firstLine = firstLine
    this.filePath = filePath ?? ''
  }

  render(themeName: string, width: number, dim: boolean): string[] | null {
    const maxLineNumber = Math.max(
      Math.max(0, this.hunk.oldStart + this.hunk.oldLines - 1),
      Math.max(0, this.hunk.newStart + this.hunk.newLines - 1),
    )
    const gutterWidth = String(maxLineNumber).length

    // First pass: markers and line numbers.
    let oldCounter = this.hunk.oldStart
    let newCounter = this.hunk.newStart
    const lines: RenderLine[] = this.hunk.lines.map(raw => {
      const first = raw[0]
      const marker = first === '+' || first === '-' ? first : ' '
      const code = first === '+' || first === '-' ? raw.slice(1) : raw.startsWith(' ') ? raw.slice(1) : raw
      if (marker === '+') return { marker, lineNumber: newCounter++, code }
      if (marker === '-') return { marker, lineNumber: oldCounter++, code }
      const lineNumber = newCounter
      oldCounter++
      newCounter++
      return { marker, lineNumber, code }
    })

    // Word-diff ranges for paired lines — only when not dimming (bands are
    // too loud in a dimmed render).
    const wordRanges = new Map<number, CharRange[]>()
    if (!dim) {
      const markers = lines.map(line => (line.marker === ' ' ? ' ' : (line.marker as string)))
      for (const pair of pairChangedLines(markers)) {
        const diff = wordDiff(lines[pair.deleted]!.code, lines[pair.added]!.code)
        wordRanges.set(pair.deleted, diff.removed)
        wordRanges.set(pair.added, diff.added)
      }
    }

    return renderLines(
      lines,
      themeName,
      width,
      dim,
      this.filePath,
      this.firstLine,
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
    const split = this.source.split('\n')
    // A trailing empty line (from a final newline) drops, matching the
    // reference's line iterator.
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

export type ColorDiffClass = typeof ColorDiff
export type ColorFileClass = typeof ColorFile

/** The vendored reporter record: the default syntax-theme NAME for a UI
 *  theme, with a null source. */
export type SyntaxTheme = { theme: string; source: string | null }

/**
 * Theme reporting: always the default for the given UI theme (there is no
 * alternative theme set).
 */
export function getSyntaxTheme(uiTheme: string): SyntaxTheme {
  const theme = uiTheme.includes('ansi')
    ? 'ansi'
    : uiTheme.includes('dark') || uiTheme.includes('black')
      ? 'Monokai Extended'
      : 'GitHub'
  return { theme, source: null }
}

export type NativeModule = {
  ColorDiff: ColorDiffClass
  ColorFile: ColorFileClass
  getSyntaxTheme: typeof getSyntaxTheme
}

let nativeModule: NativeModule | null = null

/** The lazy accessor matching the vendored loader API; never actually null
 *  in this implementation (the declared type keeps parity). */
export function getNativeModule(): NativeModule | null {
  if (!nativeModule) {
    nativeModule = { ColorDiff, ColorFile, getSyntaxTheme }
  }
  return nativeModule
}

/** Testing-only internals. */
export const __test = {
  tokenize,
  pairChangedLines,
  wordDiff,
  quantizeToAnsi256,
  emitBlocks,
  detectColorMode,
  detectLanguage,
}
