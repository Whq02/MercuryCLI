import { structuredPatch } from 'diff'

import { addToTotalLinesChanged } from '../bootstrap/state.js'
import { convertLeadingTabsToSpaces } from './file.js'

/**
 * Structured patch hunks for display, plus changed-line counting.
 */

export const CONTEXT_LINES = 3
export const DIFF_TIMEOUT_MS = 5_000

export type StructuredPatchHunk = {
  oldStart: number
  oldLines: number
  newStart: number
  newLines: number
  lines: string[]
}

// The underlying diff library mishandles ampersands and dollar signs, so
// both are swapped for sentinel tokens before diffing and substituted back
// on every emitted hunk line. Line-ending normalisation here covers every
// caller: a stray CR surviving in only one input otherwise produces
// CR-terminated hunk lines that garble the rendered diff on Windows.
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

/**
 * A structured patch between two contents. A single-hunk request uses a
 * context large enough that any real file collapses to one hunk.
 */
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

/**
 * A display patch for a list of edits applied to the file contents.
 * Leading tabs become spaces on the contents AND on both sides of each edit
 * (so the returned diff renders all leading tabs as spaces); edits apply by
 * sequential string replacement using a FUNCTION replacement, so
 * dollar-sign sequences in the new content are never interpreted as
 * capture-group references.
 */
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

/**
 * Shift hunk line numbers by an offset (callers that diffed a slice pass
 * the slice offset minus one); a zero offset returns the input unchanged.
 */
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

/**
 * Count changed lines and report them to the cost tracker. With no hunks
 * and new-file content supplied, every line of that content is an addition.
 */
export function countLinesChanged(patch: StructuredPatchHunk[], newFileContent?: string): void {
  let added = 0
  let removed = 0
  if (patch.length === 0 && newFileContent !== undefined) {
    // CRLF-or-LF only: a lone CR is not a line break.
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
