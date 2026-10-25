import { structuredPatch } from 'diff'

import { addToTotalLinesChanged } from '../bootstrap/state.js'
import { convertLeadingTabsToSpaces } from './file.js'

const CONTEXT_LINES = 3
export const DIFF_TIMEOUT_MS = 5_000

export type StructuredPatchHunk = {
  oldStart: number
  oldLines: number
  newStart: number
  newLines: number
  lines: string[]
}

type DiffOptions = Parameters<typeof structuredPatch>[6]

const SENTINELS: ReadonlyArray<readonly [glyph: string, token: string]> = [
  ['&', '\x00MERCURY_AMP\x00'],
  ['$', '\x00MERCURY_DOLLAR\x00'],
]

const prepare = (content: string): string =>
  SENTINELS.reduce((text, [glyph, token]) => text.replaceAll(glyph, token), content.replace(/\r\n?/g, '\n'))

const restore = (line: string): string => SENTINELS.reduce((text, [glyph, token]) => text.replaceAll(token, glyph), line)

function hunksBetween(filePath: string, before: string, after: string, options: { context: number; ignoreWhitespace?: boolean }): StructuredPatchHunk[] {
  const settings = { ...options, timeout: DIFF_TIMEOUT_MS } as DiffOptions
  const patch = structuredPatch(filePath, filePath, before, after, undefined, undefined, settings)
  return (patch?.hunks ?? []).map(hunk => ({ ...hunk, lines: hunk.lines.map(restore) }))
}

export function getPatchFromContents({
  filePath,
  oldContent,
  newContent,
  ignoreWhitespace,
  singleHunk,
}: {
  filePath: string
  oldContent: string
  newContent: string
  ignoreWhitespace?: boolean
  singleHunk?: boolean
}): StructuredPatchHunk[] {
  const context = singleHunk ? 100_000 : CONTEXT_LINES
  return hunksBetween(filePath, prepare(oldContent), prepare(newContent), { context, ignoreWhitespace })
}

type DisplayEdit = { old_string: string; new_string: string; replace_all?: boolean }

const applyEdit = (text: string, edit: DisplayEdit): string => {
  const from = prepare(convertLeadingTabsToSpaces(edit.old_string))
  const to = prepare(convertLeadingTabsToSpaces(edit.new_string))
  return edit.replace_all ? text.replaceAll(from, () => to) : text.replace(from, () => to)
}

export function getPatchForDisplay({
  filePath,
  fileContents,
  edits,
  ignoreWhitespace,
}: {
  filePath: string
  fileContents: string
  edits: DisplayEdit[]
  ignoreWhitespace?: boolean
}): StructuredPatchHunk[] {
  const before = prepare(convertLeadingTabsToSpaces(fileContents))
  const after = edits.reduce(applyEdit, before)
  return hunksBetween(filePath, before, after, { context: CONTEXT_LINES, ignoreWhitespace })
}

export function adjustHunkLineNumbers(hunks: StructuredPatchHunk[], offset: number): StructuredPatchHunk[] {
  const shifted = (hunk: StructuredPatchHunk): StructuredPatchHunk => ({ ...hunk, oldStart: hunk.oldStart + offset, newStart: hunk.newStart + offset })
  return offset === 0 ? hunks : hunks.map(shifted)
}

const LINE_BREAK = /\r\n|\n/

export function countLinesChanged(patch: StructuredPatchHunk[], newFileContent?: string): void {
  const marks = patch.flatMap(hunk => hunk.lines.map(line => line[0]))
  const added = patch.length === 0 && newFileContent !== undefined ? newFileContent.split(LINE_BREAK).length - (newFileContent === '' || newFileContent.endsWith('\n') ? 1 : 0) : marks.filter(mark => mark === '+').length
  const removed = marks.filter(mark => mark === '-').length
  addToTotalLinesChanged(added, removed)
}
