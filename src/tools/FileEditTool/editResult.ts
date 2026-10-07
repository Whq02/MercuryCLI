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
  spellLineRanges,
  widenLineRanges,
  type CarriedWindow,
  type LineRange,
  type ReadThroughBound,
} from './readThrough.js'

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
