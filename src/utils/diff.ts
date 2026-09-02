import { structuredPatch } from 'diff'

import { addToTotalLinesChanged } from '../bootstrap/state.js'
import { convertLeadingTabsToSpaces } from './file.js'


export const CONTEXT_LINES = 3
export const DIFF_TIMEOUT_MS = 5_000

export type StructuredPatchHunk = {
  oldStart: number
  oldLines: number
  newStart: number
  newLines: number
  lines: string[]
}

const AMPERSAND_TOKEN = '\x00MERCURY_AMP\x00'
const DOLLAR_TOKEN = '\x00MERCURY_DOLLAR\x00'

function escapeForDiff(content: string): string {
  return content
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replaceAll('&', AMPERSAND_TOKEN)
    .replaceAll('$', DOLLAR_TOKEN)
}

function unescapeLine(line: string): string {
  return line.replaceAll(AMPERSAND_TOKEN, '&').replaceAll(DOLLAR_TOKEN, '$')
}

function unescapeHunks(hunks: StructuredPatchHunk[]): StructuredPatchHunk[] {
  return hunks.map(hunk => ({ ...hunk, lines: hunk.lines.map(unescapeLine) }))
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
  const patch = structuredPatch(
    filePath,
    filePath,
    escapeForDiff(oldContent),
    escapeForDiff(newContent),
    undefined,
    undefined,
    {
      context: singleHunk ? 100_000 : CONTEXT_LINES,
      ignoreWhitespace,
      timeout: DIFF_TIMEOUT_MS,
    } as Parameters<typeof structuredPatch>[6],
  )
  if (!patch) return []
  return unescapeHunks(patch.hunks as StructuredPatchHunk[])
}

export function getPatchForDisplay({
  filePath,
  fileContents,
  edits,
  ignoreWhitespace,
}: {
  filePath: string
  fileContents: string
  edits: Array<{ old_string: string; new_string: string; replace_all?: boolean }>
  ignoreWhitespace?: boolean
}): StructuredPatchHunk[] {
  const prepared = escapeForDiff(convertLeadingTabsToSpaces(fileContents))
  let updated = prepared
  for (const edit of edits) {
    const oldEscaped = escapeForDiff(convertLeadingTabsToSpaces(edit.old_string))
    const newEscaped = escapeForDiff(convertLeadingTabsToSpaces(edit.new_string))
    updated = edit.replace_all
      ? updated.replaceAll(oldEscaped, () => newEscaped)
      : updated.replace(oldEscaped, () => newEscaped)
  }
  const patch = structuredPatch(filePath, filePath, prepared, updated, undefined, undefined, {
    context: CONTEXT_LINES,
    ignoreWhitespace,
    timeout: DIFF_TIMEOUT_MS,
  } as Parameters<typeof structuredPatch>[6])
  if (!patch) return []
  return unescapeHunks(patch.hunks as StructuredPatchHunk[])
}

export function adjustHunkLineNumbers(
  hunks: StructuredPatchHunk[],
  offset: number,
): StructuredPatchHunk[] {
  if (offset === 0) return hunks
  return hunks.map(hunk => ({
    ...hunk,
    oldStart: hunk.oldStart + offset,
    newStart: hunk.newStart + offset,
  }))
}

export function countLinesChanged(patch: StructuredPatchHunk[], newFileContent?: string): void {
  let added = 0
  let removed = 0
  if (patch.length === 0 && newFileContent !== undefined) {
    added = newFileContent.split(/\r\n|\n/).length
  } else {
    for (const hunk of patch) {
      for (const line of hunk.lines) {
        if (line.startsWith('+')) added++
        else if (line.startsWith('-')) removed++
      }
    }
  }
  addToTotalLinesChanged(added, removed)
}
