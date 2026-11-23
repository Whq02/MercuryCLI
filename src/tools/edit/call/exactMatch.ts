import type { ToolUseContext } from '../../kit/tool.js'
import type { ChangeSetMemberEdit, ExactEditOutcome } from '../../engines/change-transaction/changeSetContracts.js'
import type { EditHunkInput } from '../../engines/change-transaction/hunks.js'
import { lineCountOfText as lineCountOf } from '../../engines/change-transaction/seenLines.js'
import type { FileEditInput } from '../schema.js'
import { editSearchString, locateActualString, preserveQuoteStyleCandidates, stripSequentialReadPrefixes, type ActualMatchOutcome } from './editMatching.js'
import { matchRangesOf, notUniqueMessage, spellNamedRanges } from '../editResult.js'
import { coalesceLineRanges, type LineRange } from '../readThrough.js'
import { noMatchWords } from './readKnowledge.js'

type NotUniqueRefusal = { result: false; behavior: 'ask'; message: string; errorCode: 9; meta: Record<string, string> }

export function notUniqueRefusal(
  currentContent: string,
  oldString: string,
  replaceAll: boolean,
  located: Exclude<ActualMatchOutcome, { kind: 'none' }>,
): NotUniqueRefusal | null {
  let matches: LineRange[]
  let spelling: 'same' | 'differs'
  if (located.kind === 'ambiguous') {
    matches = located.matches
    spelling = 'differs'
  } else {
    matches = matchRangesOf(currentContent, located.actual)
    if (matches.length < 2 || replaceAll) return null
    spelling = 'same'
  }
  return {
    result: false,
    behavior: 'ask',
    errorCode: 9,
    message: notUniqueMessage({ count: matches.length, road: located.road, spelling, replaceAll, matches, lineCount: lineCountOf(currentContent), oldString }),
    meta: { oldString, ...(located.kind === 'found' ? { actualOldString: located.actual } : {}), matchLines: spellNamedRanges(matches) },
  }
}

export const IDENTICAL_EDIT_MESSAGE = 'old_string and new_string are identical — there is no edit to apply.'

type NoMatchReads = { context: ToolUseContext; expandedPath: string; displayPath: string; expectedAnchor: string | undefined }

export function notFoundMessage(currentContent: string, oldString: string, newString: string, reads: NoMatchReads | undefined): string {
  const composedElsewhere = oldString !== '' && currentContent.normalize('NFC').includes(oldString.normalize('NFC'))
  const hint = composedElsewhere
    ? ' The file spells this text with another Unicode composition of the same letters (accents stored as separate combining marks, or the reverse) — a Read of the lines carries the file\'s own spelling; copy old_string from it.'
    : ''
  const words = reads === undefined ? '' : noMatchWords(reads.context, reads.expandedPath, reads.displayPath, currentContent, reads.expectedAnchor, oldString, newString)
  return `The old_string was not found in the file.${hint}${words}\nString: ${oldString}`
}

export function matchExactEdit(
  content: string,
  edit: ChangeSetMemberEdit,
  reads?: NoMatchReads,
  prose?: (firstLine: string) => boolean,
): ExactEditOutcome {
  let oldString: string
  let newString: string
  try {
    oldString = stripSequentialReadPrefixes(edit.old_string, content)
    newString = stripSequentialReadPrefixes(edit.new_string, content)
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) }
  }
  if (oldString === newString) return { ok: false, message: IDENTICAL_EDIT_MESSAGE }
  const located = locateActualString(content, oldString)
  if (located.kind !== 'none') {
    const notUnique = notUniqueRefusal(content, oldString, edit.replace_all === true, located)
    if (notUnique !== null) return { ok: false, message: notUnique.message }
  }
  if (located.kind !== 'found') return { ok: false, message: notFoundMessage(content, oldString, newString, reads) }
  const { exact, styled } = preserveQuoteStyleCandidates(oldString, located.actual, newString)
  const replacement = exact !== styled && prose?.(content.split('\n', 1)[0] ?? '') === true ? styled : exact
  return { ok: true, actual: located.actual, replacement, search: editSearchString(content, located.actual, replacement) }
}

export function withoutReadPrefixes(input: FileEditInput, referenceText: string): FileEditInput {
  return {
    ...input,
    ...(input.old_string !== undefined ? { old_string: stripSequentialReadPrefixes(input.old_string, referenceText) } : {}),
    ...(input.new_string !== undefined ? { new_string: stripSequentialReadPrefixes(input.new_string, referenceText) } : {}),
    ...(input.append !== undefined ? { append: stripSequentialReadPrefixes(input.append, referenceText) } : {}),
    ...(input.hunks !== undefined ? { hunks: input.hunks.map(hunk => ({ ...hunk, replace: stripSequentialReadPrefixes(hunk.replace, referenceText) })) } : {}),
  }
}

export function linesOfHunks(hunks: readonly EditHunkInput[] | undefined): LineRange[] | null {
  if (hunks === undefined || hunks.length === 0) return null
  const ranges: LineRange[] = []
  for (const hunk of hunks) {
    const parsed = /^\s*(\d+)(?:#[0-9a-fA-F]+)?(?:-(\d+)(?:#[0-9a-fA-F]+)?)?\s*$/.exec(hunk.lines)
    if (!parsed) return null
    const start = Number(parsed[1])
    const end = parsed[2] === undefined ? start : Number(parsed[2])
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 1 || end < start) return null
    ranges.push({ start, end })
  }
  return coalesceLineRanges(ranges)
}
