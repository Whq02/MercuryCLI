import { mintFileAnchor, mintRangeAnchor } from '../../services/changeTransaction/snapshotAnchor.js'
import type { StructuredPatchHunk } from '../../utils/diff.js'
import { plural } from '../../utils/stringUtils.js'
import { getDefaultFileReadingLimits } from '../FileReadTool/limits.js'
import {
  READ_THROUGH_MARGIN,
  coalesceLineRanges,
  linesOutside,
  planReadThrough,
  readWindowBound,
  renderCarriedWindows,
  spellLineRanges,
  widenLineRanges,
  type CarriedWindow,
  type LineRange,
  type ReadThroughBound,
} from './readThrough.js'
import { locateActualString } from './utils.js'

export const EDIT_RESULT_MAX_ROWS = 60
export const EDIT_RESULT_MAX_RENDERED_CHARS = 6000
export const EDIT_RESULT_NAMED_RANGES = 20
export const EDIT_RESULT_CLOSE = 'Checking this edit needs no Read; Read only lines this result does not show.'

export type EditChangeKind = 'changed' | 'added' | 'removed'

export type EditChange = { kind: EditChangeKind; start: number; end: number; removedLines?: number }

export type ReadBack = 'same' | 'differs' | 'failed'

export type EditedLines = {
  what: string
  where: string
  occurrences?: number
  changes: EditChange[]
  lineCount: number
  endsWithNewline: boolean
  shown: { start: number; end: number; anchor: string }[]
  notShown: LineRange[]
  readBack: ReadBack
  body: string
}

export type WindowReader = (start: number, count: number) => Promise<string[]>

export type ShownWindow = { start: number; end: number; rows: string[]; anchor: string }

export function editResultBound(): ReadThroughBound {
  return { maxLines: EDIT_RESULT_MAX_ROWS, maxTokens: getDefaultFileReadingLimits().maxTokens, maxRenderedChars: EDIT_RESULT_MAX_RENDERED_CHARS }
}

function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
}

export function linesOfText(text: string): string[] {
  const body = stripBom(text)
  if (body === '') return []
  const lines = body.split('\n')
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop()
  return lines
}

export function changesOfPatch(hunks: readonly StructuredPatchHunk[]): EditChange[] {
  const out: EditChange[] = []
  for (const hunk of hunks) {
    let newLine = hunk.newStart
    let run: { removed: number; plusStart: number; plusEnd: number } | null = null
    const flush = (): void => {
      if (run === null) return
      if (run.plusEnd >= run.plusStart) {
        out.push({ kind: run.removed > 0 ? 'changed' : 'added', start: run.plusStart, end: run.plusEnd })
      } else {
        out.push({ kind: 'removed', start: newLine, end: newLine, removedLines: run.removed })
      }
      run = null
    }
    for (const text of hunk.lines) {
      const mark = text[0]
      if (mark === '\\') continue
      if (mark === '-') {
        run ??= { removed: 0, plusStart: newLine, plusEnd: newLine - 1 }
        run.removed++
      } else if (mark === '+') {
        run ??= { removed: 0, plusStart: newLine, plusEnd: newLine - 1 }
        run.plusEnd = newLine
        newLine++
      } else {
        flush()
        newLine++
      }
    }
    flush()
  }
  return out
}

export function spellNamedRanges(ranges: readonly LineRange[]): string {
  const named = ranges.slice(0, EDIT_RESULT_NAMED_RANGES)
  const rest = ranges.length - named.length
  return `${spellLineRanges(named)}${rest > 0 ? `, and ${rest} more` : ''}`
}

function spellKind(kind: 'changed' | 'added', ranges: readonly LineRange[]): string {
  const one = ranges.length === 1 && ranges[0]!.start === ranges[0]!.end
  return `${kind} ${one ? 'line' : 'lines'} ${spellNamedRanges(ranges)}`
}

export function spellWhere(changes: readonly EditChange[], lineCount: number): string {
  const parts: string[] = []
  const changed = changes.filter(change => change.kind === 'changed').map(change => ({ start: change.start, end: change.end }))
  const added = changes.filter(change => change.kind === 'added').map(change => ({ start: change.start, end: change.end }))
  if (changed.length > 0) parts.push(spellKind('changed', changed))
  if (added.length > 0) parts.push(spellKind('added', added))
  const removed = changes.filter(change => change.kind === 'removed')
  const namedRemovals = removed.slice(0, EDIT_RESULT_NAMED_RANGES)
  for (const run of namedRemovals) {
    const count = run.removedLines ?? 0
    const where = run.start > lineCount ? 'at the end' : `before line ${run.start}`
    parts.push(`removed ${count} ${plural(count, 'line')} ${where}`)
  }
  const more = removed.length - namedRemovals.length
  if (more > 0) parts.push(`and ${more} more ${plural(more, 'removal')}`)
  return parts.join('; ')
}

export function sizeWords(lineCount: number, endsWithNewline: boolean): string {
  if (lineCount === 0) return 'the file is now empty'
  return `the file has ${lineCount} ${plural(lineCount, 'line')}${endsWithNewline ? '' : ' and does not end with a newline'}`
}

export function changedLineRanges(changes: readonly EditChange[]): LineRange[] {
  return coalesceLineRanges(changes.filter(change => change.kind !== 'removed').map(change => ({ start: change.start, end: change.end })))
}

export function changeWindowSeeds(changes: readonly EditChange[], lineCount: number): LineRange[] {
  if (lineCount === 0) return []
  const seeds: LineRange[] = []
  for (const change of changes) {
    if (change.kind !== 'removed') {
      seeds.push({ start: change.start, end: change.end })
    } else if (change.start > lineCount) {
      seeds.push({ start: lineCount, end: lineCount })
    } else {
      seeds.push({ start: Math.max(1, change.start - 1), end: Math.min(lineCount, change.start) })
    }
  }
  return coalesceLineRanges(seeds)
}

export function readNext(range: LineRange, lineCount: number): { offset: number; limit: number } {
  const offset = Math.max(1, range.start - READ_THROUGH_MARGIN)
  const limit = Math.max(1, Math.min(lineCount, range.end + READ_THROUGH_MARGIN) - offset + 1)
  return { offset, limit }
}

export function renderShownWindows(windows: readonly ShownWindow[]): string {
  return windows
    .map(window => `${window.rows.map((line, index) => `${window.start + index}\t${line}`).join('\n')}\n(anchor: ${window.anchor})`)
    .join('\n\n')
}

export function anchorShownWindows(
  windows: readonly { start: number; rows: string[] }[],
  whole: { lineCount: number; text: string } | null,
): ShownWindow[] {
  return windows.map(window => {
    const end = window.start + window.rows.length - 1
    const isWhole = whole !== null && windows.length === 1 && window.start === 1 && end === whole.lineCount
    const anchor = isWhole ? mintFileAnchor(whole.text) : mintRangeAnchor(window.rows.join('\n'), window.start, window.rows.length)
    return { start: window.start, end, rows: window.rows, anchor }
  })
}

export function planShownWindows(text: string, ranges: readonly LineRange[], path: string, bound: ReadThroughBound = editResultBound()): CarriedWindow[] {
  return planReadThrough(text, ranges, path, bound).windows
}

export type EditedLinesInput = {
  written: string
  patch: readonly StructuredPatchHunk[]
  what: string
  occurrences?: number
  path: string
  readWindow: WindowReader
  readThrough?: { sentence: string; windows: readonly LineRange[] }
  freshAnchors?: string
}

export type EditedLinesResult = { editedLines: EditedLines; windows: CarriedWindow[] }

function wideBound(): ReadThroughBound {
  const read = readWindowBound()
  return { maxLines: read.maxLines + EDIT_RESULT_MAX_ROWS, maxTokens: read.maxTokens + EDIT_RESULT_MAX_RENDERED_CHARS }
}

export async function buildEditedLines(input: EditedLinesInput): Promise<EditedLinesResult> {
  const text = stripBom(input.written)
  const lines = linesOfText(text)
  const lineCount = lines.length
  const endsWithNewline = text.endsWith('\n')
  const changes = changesOfPatch(input.patch)
  const where = spellWhere(changes, lineCount)
  const changedLines = changedLineRanges(changes)
  const base: Omit<EditedLines, 'shown' | 'notShown' | 'readBack' | 'body'> = {
    what: input.what,
    where,
    ...(input.occurrences !== undefined ? { occurrences: input.occurrences } : {}),
    changes,
    lineCount,
    endsWithNewline,
  }
  const seeds = widenLineRanges(changeWindowSeeds(changes, lineCount), READ_THROUGH_MARGIN, lineCount)
  let planned = planShownWindows(text, seeds, input.path)
  if (input.readThrough !== undefined) {
    const union = coalesceLineRanges([...input.readThrough.windows, ...planned.map(window => ({ start: window.start, end: window.end }))])
    planned = planShownWindows(text, union, input.path, wideBound())
  }
  let readBack: ReadBack = 'same'
  const shownWindows: { start: number; rows: string[] }[] = []
  const wholeFile = planned.length === 1 && planned[0]!.start === 1 && planned[0]!.end === lineCount
  try {
    for (const window of planned) {
      const count = window.end - window.start + 1
      const rows = await input.readWindow(window.start, wholeFile ? count + 1 : count)
      const expected = window.content.split('\n')
      if (wholeFile) {
        const diskEndsWithNewline = rows.length === count + 1 && rows[count] === ''
        if (diskEndsWithNewline) rows.pop()
        if (rows.length !== expected.length || rows.some((row, index) => row !== expected[index]) || diskEndsWithNewline !== endsWithNewline) {
          readBack = 'differs'
        }
      } else if (rows.length !== expected.length || rows.some((row, index) => row !== expected[index])) {
        readBack = 'differs'
      }
      if (rows.length > 0) shownWindows.push({ start: window.start, rows })
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return {
      editedLines: {
        ...base,
        shown: [],
        notShown: changedLines,
        readBack: 'failed',
        body: `The edit was written, but reading it back failed (${message}); Read the lines to see what stands.`,
      },
      windows: [],
    }
  }
  const shown = anchorShownWindows(shownWindows, readBack === 'same' ? { lineCount, text } : null)
  const shownRanges = shown.map(window => ({ start: window.start, end: window.end }))
  const notShown = linesOutside(changedLines, shownRanges)
  const windows: CarriedWindow[] = shown.map(window => ({ start: window.start, end: window.end, content: window.rows.join('\n'), anchor: window.anchor }))
  let body: string
  if (input.freshAnchors !== undefined) {
    body = input.freshAnchors
  } else {
    const parts: string[] = []
    if (input.readThrough !== undefined) {
      parts.push(input.readThrough.sentence)
    } else if (shown.length > 0) {
      const spelled = spellLineRanges(shownRanges)
      parts.push(
        readBack === 'differs'
          ? `Lines ${spelled} as read back right after the write differ from what this edit wrote — the file changed again at once; these are what stands and count as read:`
          : wholeFile && shownRanges.length === 1 && shownRanges[0]!.start === 1 && shownRanges[0]!.end === lineCount
            ? 'The whole file as read back right after the write; it counts as read:'
            : `Lines ${spelled} as read back right after the write; they count as read:`,
      )
    }
    if (shown.length > 0) parts.push(renderShownWindows(shown))
    if (notShown.length > 0) {
      const next = readNext(notShown[0]!, lineCount)
      parts.push(`Not shown: changed lines ${spellNamedRanges(notShown)} — Read(offset: ${next.offset}, limit: ${next.limit}) shows the first of them.`)
    }
    body = parts.join('\n')
  }
  return {
    editedLines: {
      ...base,
      shown: shown.map(window => ({ start: window.start, end: window.end, anchor: window.anchor })),
      notShown,
      readBack,
      body,
    },
    windows,
  }
}

export function editResultHead(path: string, modifiedClause: string, edited: EditedLines): string {
  const where = edited.where === '' ? '' : `; ${edited.where}`
  return `The file ${path} has been updated successfully${modifiedClause}: ${edited.what}${where} (${sizeWords(edited.lineCount, edited.endsWithNewline)}).`
}

export type NotUniqueWords = {
  count: number
  road: 'exact' | 'quotes' | 'characters' | 'whitespace' | 'indentation' | 'escapes'
  spelling: 'same' | 'differs'
  replaceAll: boolean
  matches: readonly LineRange[]
  lineCount: number
  oldString: string
}

export function roadWords(road: NotUniqueWords['road']): string {
  switch (road) {
    case 'exact':
      return ''
    case 'quotes':
      return ' (found after straightening quotes)'
    case 'characters':
      return ' (found after ignoring dash and space characters)'
    case 'whitespace':
      return ' (found after ignoring trailing whitespace)'
    case 'indentation':
      return ' (found after ignoring indentation)'
    case 'escapes':
      return ' (found after reading the \\n, \\t and \\r sequences as the characters they spell)'
  }
}

export function notUniqueMessage(words: NotUniqueWords): string {
  const opening =
    words.spelling === 'same'
      ? `Found ${words.count} matches of the string to replace, but replace_all is false, so nothing was written.`
      : `Found ${words.count} matches of the string to replace, but they differ from each other in whitespace or characters${words.replaceAll ? ', so replace_all cannot rewrite them as one string' : ''}; nothing was written.`
  const first = words.matches[0]
  const next = first === undefined ? null : readNext(first, words.lineCount)
  const shown = next === null ? 'Read the lines to see them' : `Read(offset: ${next.offset}, limit: ${next.limit}) shows the first with its neighbours`
  const advice =
    words.spelling === 'same'
      ? 'To change one, send old_string again with a neighbouring line that differs between them; to change every match, set replace_all to true.'
      : 'Send old_string spelled as the file spells the one you mean, with a neighbouring line if that spelling occurs more than once.'
  return `${opening} The matches${roadWords(words.road)} are at lines ${spellNamedRanges(words.matches)}; ${shown}. ${advice}\n\nString: ${words.oldString}`
}

export function matchRangesOf(content: string, actual: string): LineRange[] {
  if (actual === '') return []
  const ranges: LineRange[] = []
  const height = actual.replace(/\n$/, '').split('\n').length - 1
  let from = 0
  let line = 1
  for (let at = content.indexOf(actual); at !== -1; at = content.indexOf(actual, from)) {
    line += content.slice(from, at).split('\n').length - 1
    ranges.push({ start: line, end: line + height })
    line += actual.split('\n').length - 1
    from = at + actual.length
  }
  return ranges
}

const NO_MATCH_WINDOWS = 3
const NO_MATCH_MIN_SIMILARITY = 0.6
const NO_MATCH_COMMON_LINE = 50
const NO_MATCH_ANCHOR_HITS = 20
const NO_MATCH_PAIRS = 3

export type NoMatchInput = { content: string; oldString: string; newString: string; read: readonly LineRange[]; path: string }

type Candidate = { start: number; score: number }

type Spelling = { lines: string[]; keys: string[]; escaped: boolean }

function foldWhitespace(line: string): string {
  return line.replace(/\s+/g, '')
}

function bigramsOf(text: string): Map<string, number> {
  const out = new Map<string, number>()
  for (let i = 0; i + 1 < text.length; i++) {
    const pair = text.slice(i, i + 2)
    out.set(pair, (out.get(pair) ?? 0) + 1)
  }
  return out
}

function lineSimilarity(a: string, b: string): number {
  if (a === b) return 1
  if (a.length < 2 || b.length < 2) return 0
  const left = bigramsOf(a)
  const right = bigramsOf(b)
  let shared = 0
  for (const [pair, count] of left) shared += Math.min(count, right.get(pair) ?? 0)
  return (2 * shared) / (a.length - 1 + (b.length - 1))
}

function unescapeWire(text: string): string {
  return text.replace(/\\([ntr"'\\])/g, (_match, char: string) => (char === 'n' ? '\n' : char === 't' ? '\t' : char === 'r' ? '\r' : char))
}

function linesOfString(text: string): string[] {
  return (text.endsWith('\n') ? text.slice(0, -1) : text).split('\n')
}

function visibleWhitespace(line: string): string {
  return line.replaceAll('\t', '→').replaceAll(' ', '·')
}

function closestStarts(fileKeys: readonly string[], readAt: Uint8Array, oldKeys: readonly string[]): Candidate[] {
  const k = oldKeys.length
  const n = fileKeys.length
  if (k === 0 || k > n) return []
  const index = new Map<string, number[]>()
  for (let j = 0; j < n; j++) {
    const key = fileKeys[j]!
    if (key === '' || readAt[j] === 0) continue
    const at = index.get(key)
    if (at === undefined) index.set(key, [j])
    else at.push(j)
  }
  const starts = new Set<number>()
  let anchor = -1
  for (let i = 0; i < k; i++) {
    const key = oldKeys[i]!
    if (key === '') continue
    if (anchor === -1 || key.length > oldKeys[anchor]!.length) anchor = i
    const at = index.get(key)
    if (at !== undefined && at.length <= NO_MATCH_COMMON_LINE) for (const j of at) starts.add(j - i)
  }
  if (anchor === -1) return []
  const near: Candidate[] = []
  for (let j = 0; j < n; j++) {
    if (readAt[j] === 0 || fileKeys[j] === '') continue
    const score = lineSimilarity(oldKeys[anchor]!, fileKeys[j]!)
    if (score >= NO_MATCH_MIN_SIMILARITY) near.push({ start: j - anchor, score })
  }
  near.sort((a, b) => b.score - a.score || a.start - b.start)
  for (const hit of near.slice(0, NO_MATCH_ANCHOR_HITS)) starts.add(hit.start)
  const scored: Candidate[] = []
  for (const start of starts) {
    if (start < 0 || start + k > n) continue
    let total = 0
    let inside = true
    for (let i = 0; i < k; i++) {
      if (readAt[start + i] === 0) {
        inside = false
        break
      }
      let best = lineSimilarity(oldKeys[i]!, fileKeys[start + i]!)
      for (const slack of [-1, 1]) {
        const j = start + i + slack
        if (best < 1 && j >= 0 && j < n && readAt[j] === 1) best = Math.max(best, lineSimilarity(oldKeys[i]!, fileKeys[j]!))
      }
      total += best
    }
    if (!inside) continue
    const score = total / k
    if (score >= NO_MATCH_MIN_SIMILARITY) scored.push({ start, score })
  }
  scored.sort((a, b) => b.score - a.score || a.start - b.start)
  const chosen: Candidate[] = []
  for (const candidate of scored) {
    if (chosen.length === NO_MATCH_WINDOWS) break
    if (chosen.some(taken => Math.abs(taken.start - candidate.start) < k)) continue
    chosen.push(candidate)
  }
  return chosen
}

const WORD_CHARACTER = /\w/

function wholeMatchRanges(content: string, actual: string): LineRange[] {
  const ranges: LineRange[] = []
  const height = actual.replace(/\n$/, '').split('\n').length - 1
  let from = 0
  let line = 1
  for (let at = content.indexOf(actual); at !== -1; at = content.indexOf(actual, from)) {
    line += content.slice(from, at).split('\n').length - 1
    const before = at === 0 ? '' : content[at - 1]!
    const after = content[at + actual.length] ?? ''
    const glued =
      (WORD_CHARACTER.test(actual[0]!) && WORD_CHARACTER.test(before)) ||
      (WORD_CHARACTER.test(actual[actual.length - 1]!) && WORD_CHARACTER.test(after))
    if (!glued) ranges.push({ start: line, end: line + height })
    line += actual.split('\n').length - 1
    from = at + actual.length
  }
  return ranges
}

function presentAt(content: string, newString: string, read: readonly LineRange[]): LineRange[] {
  if (newString.trim() === '') return []
  const located = locateActualString(content, newString)
  if (located.kind === 'none') return []
  const ranges = located.kind === 'ambiguous' ? located.matches : wholeMatchRanges(content, located.actual)
  return ranges.filter(range => linesOutside([range], read).length === 0)
}

function differenceWords(lines: readonly string[], fileKeys: readonly string[], spelling: Spelling, start: number): string | null {
  if (!spelling.keys.every((key, i) => key === fileKeys[start + i])) return null
  const differing = spelling.lines.map((_line, i) => i).filter(i => spelling.lines[i] !== lines[start + i])
  const sequences = 'old_string spells backslash sequences (\\n, \\t, \\r, \\", \\\', \\\\) where the file has the characters'
  if (differing.length === 0) {
    return spelling.escaped
      ? `They differ from old_string only in escaping: ${sequences}.`
      : 'They differ from old_string only in the newline after the last line, which the file does not have.'
  }
  const named = differing.slice(0, NO_MATCH_PAIRS)
  const rest = differing.length - named.length
  const pairs = named.flatMap(i => [`${start + i + 1} file: ${visibleWhitespace(lines[start + i]!)}`, `${start + i + 1} old_string: ${visibleWhitespace(spelling.lines[i]!)}`])
  const where = `${named.length === 1 ? 'line' : 'lines'} ${spellLineRanges(coalesceLineRanges(named.map(i => ({ start: start + i + 1, end: start + i + 1 }))))}${rest > 0 ? ` (and ${rest} more)` : ''}`
  const verb = named.length === 1 && rest === 0 ? 'differs' : 'differ'
  const how = spelling.escaped
    ? `only in whitespace and escaping — ${sequences}; the file's spelling, then old_string's with its sequences read as characters (→ tab, · space):`
    : `only in whitespace; the file's spelling, then old_string's (→ tab, · space):`
  return [`Of these, ${where} ${verb} from old_string ${how}`, ...pairs].join('\n')
}

export function noMatchHint(input: NoMatchInput): string {
  const lines = linesOfText(input.content)
  const lineCount = lines.length
  const read = coalesceLineRanges(input.read.map(range => ({ start: Math.max(1, range.start), end: Math.min(range.end, lineCount) })))
  if (lineCount === 0 || read.length === 0) return ''
  const parts: string[] = []
  const present = presentAt(input.content, input.newString, read)
  if (present.length > 0) {
    const one = present.length === 1 && present[0]!.start === present[0]!.end
    parts.push(`new_string already stands at ${one ? 'line' : 'lines'} ${spellNamedRanges(present)} — the edit may have landed on an earlier call.`)
  }
  const readAt = new Uint8Array(lineCount)
  for (const range of read) for (let line = range.start; line <= range.end; line++) readAt[line - 1] = 1
  const fileKeys = lines.map(foldWhitespace)
  const typed = linesOfString(input.oldString)
  const unescaped = unescapeWire(input.oldString)
  const spellings: Spelling[] = [{ lines: typed, keys: typed.map(foldWhitespace), escaped: false }]
  if (unescaped !== input.oldString) {
    const escapedLines = linesOfString(unescaped)
    spellings.push({ lines: escapedLines, keys: escapedLines.map(foldWhitespace), escaped: true })
  }
  let best: { windows: Candidate[]; spelling: Spelling } | null = null
  for (const spelling of spellings) {
    const windows = closestStarts(fileKeys, readAt, spelling.keys)
    if (windows.length > 0 && (best === null || windows[0]!.score > best.windows[0]!.score)) best = { windows, spelling }
  }
  if (best !== null) {
    const k = best.spelling.lines.length
    const bound = editResultBound()
    let rowsLeft = bound.maxLines
    let charsLeft = bound.maxRenderedChars ?? Number.POSITIVE_INFINITY
    const shownRanges: LineRange[] = []
    for (const window of best.windows) {
      const range = { start: window.start + 1, end: window.start + k }
      const within = read.find(seen => seen.start <= range.start && range.end <= seen.end)!
      const shown = { start: Math.max(within.start, range.start - READ_THROUGH_MARGIN), end: Math.min(within.end, range.end + READ_THROUGH_MARGIN) }
      const touching = shownRanges.find(taken => taken.start <= shown.end + 1 && shown.start <= taken.end + 1)
      if (touching === undefined) shownRanges.push(shown)
      else {
        touching.start = Math.min(touching.start, shown.start)
        touching.end = Math.max(touching.end, shown.end)
      }
    }
    const blocks: string[] = []
    for (const shown of shownRanges) {
      if (rowsLeft <= 0 || charsLeft <= 0) break
      const plan = planReadThrough(input.content, [shown], input.path, { maxLines: rowsLeft, maxTokens: bound.maxTokens, maxRenderedChars: charsLeft })
      if (plan.windows.length === 0) break
      const block = renderCarriedWindows(plan.windows)
      blocks.push(block)
      rowsLeft -= plan.lineCount
      charsLeft -= block.length
    }
    if (blocks.length > 0) {
      parts.push('The lines read this session closest to old_string, numbered with their anchor:', blocks.join('\n\n'))
      const difference = differenceWords(lines, fileKeys, best.spelling, best.windows[0]!.start)
      if (difference !== null) parts.push(difference)
    }
  }
  return parts.join('\n')
}
