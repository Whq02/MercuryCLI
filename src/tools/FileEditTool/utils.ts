import { structuredPatch } from 'diff'

import {
  convertLeadingTabsToSpaces,
  addLineNumbers,
  readFileSyncCached,
} from '../../utils/file.js'
import { DIFF_TIMEOUT_MS, getPatchFromContents, type StructuredPatchHunk } from '../../utils/diff.js'
import { isENOENT } from '../../utils/errors.js'
import { logError } from '../../utils/log.js'
import { expandPath } from '../../utils/path.js'
import { plural } from '../../utils/stringUtils.js'
import type { FileEdit } from './types.js'

/**
 * The shared edit/patch library consumed by Edit, Write, the diff
 * components, the IDE-diff hook, the attachment builder, and the API
 * request normaliser.
 */

// ── curly-quote handling ────────────────────────────────────────────────────

// Exported as named constants because the model cannot reliably emit the
// characters directly.
export const LEFT_SINGLE_CURLY_QUOTE = '‘'
export const RIGHT_SINGLE_CURLY_QUOTE = '’'
export const LEFT_DOUBLE_CURLY_QUOTE = '“'
export const RIGHT_DOUBLE_CURLY_QUOTE = '”'

/** Map all four curly quotes onto their straight equivalents (1:1 length). */
export function normalizeQuotes(s: string): string {
  return s
    .replaceAll(LEFT_SINGLE_CURLY_QUOTE, "'")
    .replaceAll(RIGHT_SINGLE_CURLY_QUOTE, "'")
    .replaceAll(LEFT_DOUBLE_CURLY_QUOTE, '"')
    .replaceAll(RIGHT_DOUBLE_CURLY_QUOTE, '"')
}

// ── whitespace ──────────────────────────────────────────────────────────────

/**
 * Strip trailing whitespace from each line while preserving the original
 * line terminators (CRLF, LF, and lone CR all survive unchanged).
 */
export function stripTrailingWhitespace(s: string): string {
  // Whitespace-except-line-terminators, immediately before a terminator or
  // the end of the string.
  return s.replace(/[^\S\r\n]+(?=\r\n|\r|\n|$)/g, '')
}

// ── locating and re-typographing matches ────────────────────────────────────

/**
 * Locate the text a search string actually matches in the file: the search
 * string itself when it occurs literally; otherwise the slice of the
 * ORIGINAL content at the index found in the quote-normalised content
 * (the file's own typography, not the model's). Sound only because quote
 * normalisation maps one character to one character.
 */
export function findActualString(fileContent: string, searchString: string): string | null {
  if (fileContent.includes(searchString)) return searchString
  const index = normalizeQuotes(fileContent).indexOf(normalizeQuotes(searchString))
  if (index === -1) return null
  return fileContent.slice(index, index + searchString.length)
}

/** Opening-quote context: start of string or a preceding opener character. */
function isOpeningPosition(text: string, index: number): boolean {
  if (index === 0) return true
  const previous = text[index - 1] as string
  return (
    previous === ' ' ||
    previous === '\t' ||
    previous === '\n' ||
    previous === '\r' ||
    previous === '(' ||
    previous === '[' ||
    previous === '{' ||
    previous === '—' || // em dash
    previous === '–' // en dash
  )
}

const LETTER = /\p{L}/u

/** A letter-flanked apostrophe is a contraction and always closes. */
function isContraction(text: string, index: number): boolean {
  const before = index > 0 ? (text[index - 1] as string) : ''
  const after = index + 1 < text.length ? (text[index + 1] as string) : ''
  return LETTER.test(before) && LETTER.test(after)
}

/**
 * When the match succeeded only through quote normalisation, apply the
 * file's curly style to the replacement: straight doubles convert when the
 * matched text contained curly doubles, straight singles likewise. With
 * neither curly type present the replacement is returned unchanged.
 */
export function preserveQuoteStyle(
  oldString: string,
  actualOldString: string,
  newString: string,
): string {
  const hasCurlyDoubles =
    actualOldString.includes(LEFT_DOUBLE_CURLY_QUOTE) ||
    actualOldString.includes(RIGHT_DOUBLE_CURLY_QUOTE)
  const hasCurlySingles =
    actualOldString.includes(LEFT_SINGLE_CURLY_QUOTE) ||
    actualOldString.includes(RIGHT_SINGLE_CURLY_QUOTE)
  if (!hasCurlyDoubles && !hasCurlySingles) return newString

  let result = ''
  for (let i = 0; i < newString.length; i++) {
    const char = newString[i] as string
    if (char === '"' && hasCurlyDoubles) {
      result += isOpeningPosition(newString, i) ? LEFT_DOUBLE_CURLY_QUOTE : RIGHT_DOUBLE_CURLY_QUOTE
      continue
    }
    if (char === "'" && hasCurlySingles) {
      if (isContraction(newString, i)) {
        result += RIGHT_SINGLE_CURLY_QUOTE
      } else {
        result += isOpeningPosition(newString, i)
          ? LEFT_SINGLE_CURLY_QUOTE
          : RIGHT_SINGLE_CURLY_QUOTE
      }
      continue
    }
    result += char
  }
  return result
}

// ── applying edits ──────────────────────────────────────────────────────────

/**
 * Replace once, or all occurrences with the replace-all flag. Replacements
 * are inserted LITERALLY (never interpreted as replacement-pattern syntax).
 * Deleting text that is followed by a newline — when the search string does
 * not itself end in one — consumes the newline too, so deleting a line does
 * not leave a blank behind.
 */
export function applyEditToFile(
  originalContent: string,
  oldString: string,
  newString: string,
  replaceAll: boolean = false,
): string {
  let searchString = oldString
  if (
    newString === '' &&
    !oldString.endsWith('\n') &&
    originalContent.includes(`${oldString}\n`)
  ) {
    searchString = `${oldString}\n`
  }
  return replaceAll
    ? originalContent.replaceAll(searchString, () => newString)
    : originalContent.replace(searchString, () => newString)
}

function stripTrailingNewlines(s: string): string {
  return s.replace(/\n+$/, '')
}

/**
 * Sequentially apply a list of edits and produce the display patch.
 * The patch is DISPLAY-ONLY: leading tabs are converted to spaces on both
 * sides before diffing, and the patch is produced directly from the
 * before/after contents rather than by re-simulating the edits (a
 * deliberate large-file saving). The returned updatedFile is the REAL
 * applied content.
 */
export function getPatchForEdits({
  filePath,
  fileContents,
  edits,
}: {
  filePath: string
  fileContents: string
  edits: Array<{ old_string: string; new_string: string; replace_all?: boolean }>
}): { patch: StructuredPatchHunk[]; updatedFile: string } {
  // An empty file receiving a single empty→empty edit is a no-op.
  if (
    fileContents === '' &&
    edits.length === 1 &&
    edits[0]!.old_string === '' &&
    edits[0]!.new_string === ''
  ) {
    return { patch: [], updatedFile: '' }
  }

  let updatedFile = fileContents
  const appliedReplacements: string[] = []
  for (const edit of edits) {
    // An edit must not target text a prior edit in the same batch introduced.
    const strippedOld = stripTrailingNewlines(edit.old_string)
    for (const replacement of appliedReplacements) {
      if (replacement.includes(strippedOld)) {
        throw new Error(
          'Cannot edit text that was introduced by a previous edit in the same batch. Apply the edits in a single change instead.',
        )
      }
    }
    const before = updatedFile
    if (edit.old_string === '') {
      updatedFile = edit.new_string
    } else {
      updatedFile = applyEditToFile(updatedFile, edit.old_string, edit.new_string, edit.replace_all)
    }
    if (updatedFile === before) {
      throw new Error('The text to replace does not appear in the file — the edit was not applied.')
    }
    appliedReplacements.push(edit.new_string)
  }
  if (updatedFile === fileContents) {
    throw new Error('The edit left the file byte-identical — nothing was applied.')
  }
  const patch = getPatchFromContents({
    filePath,
    oldContent: convertLeadingTabsToSpaces(fileContents),
    newContent: convertLeadingTabsToSpaces(updatedFile),
  })
  return { patch, updatedFile }
}

/** The single-edit form; throws on identity or no-match like the batch form. */
export function getPatchForEdit({
  filePath,
  fileContents,
  oldString,
  newString,
  replaceAll,
}: {
  filePath: string
  fileContents: string
  oldString: string
  newString: string
  replaceAll?: boolean
}): { patch: StructuredPatchHunk[]; updatedFile: string } {
  return getPatchForEdits({
    filePath,
    fileContents,
    edits: [{ old_string: oldString, new_string: newString, replace_all: replaceAll }],
  })
}

// ── attachment snippet ──────────────────────────────────────────────────────

const TWO_FILE_SNIPPET_CONTEXT_LINES = 8
const TWO_FILE_SNIPPET_MAX_BYTES = 8192
const HUNK_SEPARATOR = '...'

/**
 * A bounded, context-rich view of the difference between two contents:
 * surviving/added lines only (markers stripped, diff metadata dropped),
 * line-numbered per hunk from the hunk's old start line, hunks joined by an
 * ellipsis separator, capped at 8 KiB with a line-boundary truncation and a
 * dropped-line marker matching the shell tool's format.
 */
export function getSnippetForTwoFileDiff(a: string, b: string): string {
  const patch = structuredPatch('a', 'b', a, b, undefined, undefined, {
    context: TWO_FILE_SNIPPET_CONTEXT_LINES,
    timeout: DIFF_TIMEOUT_MS,
  } as Parameters<typeof structuredPatch>[6])
  if (!patch) return ''

  const parts: string[] = []
  for (const hunk of patch.hunks) {
    const kept = hunk.lines
      .filter(line => !line.startsWith('-') && !line.startsWith('\\'))
      .map(line => line.slice(1))
    if (kept.length === 0) continue
    parts.push(addLineNumbers({ content: kept.join('\n'), startLine: hunk.oldStart }))
  }
  const full = parts.join(`\n${HUNK_SEPARATOR}\n`)
  if (Buffer.byteLength(full, 'utf8') <= TWO_FILE_SNIPPET_MAX_BYTES) return full

  // Truncate at the last line boundary that fits; hard-cut when none does.
  const allLines = full.split('\n')
  let kept = ''
  let keptLineCount = 0
  for (const line of allLines) {
    const candidate = kept === '' ? line : `${kept}\n${line}`
    if (Buffer.byteLength(candidate, 'utf8') > TWO_FILE_SNIPPET_MAX_BYTES) break
    kept = candidate
    keptLineCount++
  }
  if (kept === '') {
    kept = Buffer.from(full, 'utf8').subarray(0, TWO_FILE_SNIPPET_MAX_BYTES).toString('utf8')
    keptLineCount = kept.split('\n').length
  }
  const dropped = allLines.length - keptLineCount
  return `${kept}\n\n[${dropped} ${plural(dropped, 'line')} truncated]`
}

// ── patch → edits ───────────────────────────────────────────────────────────

/**
 * Convert display hunks back into edits: per hunk, the old side is context
 * plus removed lines and the new side context plus added lines.
 */
export function getEditsForPatch(patch: StructuredPatchHunk[]): FileEdit[] {
  return patch.map(hunk => {
    const oldLines: string[] = []
    const newLines: string[] = []
    for (const line of hunk.lines) {
      if (line.startsWith('-')) {
        oldLines.push(line.slice(1))
      } else if (line.startsWith('+')) {
        newLines.push(line.slice(1))
      } else if (line.startsWith(' ')) {
        oldLines.push(line.slice(1))
        newLines.push(line.slice(1))
      }
    }
    return {
      old_string: oldLines.join('\n'),
      new_string: newLines.join('\n'),
      replace_all: false,
    }
  })
}

// ── de-sanitisation ─────────────────────────────────────────────────────────

/**
 * The provider sanitises these markers out of model-visible text, so the
 * model emits the sanitised spellings in its edit strings. The spellings
 * are contract data (sanitised → original).
 */
const DESANITIZATION_TABLE: Array<[sanitized: string, original: string]> = [
  ['<fnr>', '<function_results>'],
  ['<n>', '<name>'],
  ['</n>', '</name>'],
  ['<o>', '<output>'],
  ['</o>', '</output>'],
  ['<e>', '<error>'],
  ['</e>', '</error>'],
  ['<s>', '<system>'],
  ['</s>', '</system>'],
  ['<r>', '<result>'],
  ['</r>', '</result>'],
  ['< META_START >', '<META_START>'],
  ['< META_END >', '<META_END>'],
  ['< EOT >', '<EOT>'],
  ['< META >', '<META>'],
  ['< SOS >', '<SOS>'],
  ['\n\nH:', '\n\nHuman:'],
  ['\n\nA:', '\n\nAssistant:'],
]

function applyDesanitization(s: string): string {
  let result = s
  for (const [sanitized, original] of DESANITIZATION_TABLE) {
    result = result.replaceAll(sanitized, original)
  }
  return result
}

// ── input normalisation ─────────────────────────────────────────────────────

type FileEditsInput = {
  file_path: string
  edits: Array<{ old_string?: string; new_string?: string; replace_all?: boolean }>
}

/**
 * Normalise an edit input before it is sent: trailing-whitespace-strip the
 * new strings (except markdown, where two trailing spaces are a hard line
 * break), and de-sanitise old strings that only match after the provider's
 * replacement table is undone. The path in the returned value stays exactly
 * as supplied; the read happens at the EXPANDED path with no existence
 * pre-check (a not-found file simply returns the input unchanged).
 */
export function normalizeFileEditInput<T extends FileEditsInput>(input: T): T {
  const { file_path, edits } = input
  if (edits.length === 0) return input

  let fileContent: string
  try {
    fileContent = readFileSyncCached(expandPath(file_path))
  } catch (err) {
    if (!isENOENT(err)) logError(err)
    return input
  }

  const isMarkdown = /\.(md|mdx)$/i.test(file_path)
  const normalizedEdits = edits.map(edit => {
    // Hunks-mode edits (missing either string) pass through untouched.
    if (edit.old_string === undefined || edit.new_string === undefined) return edit
    const newString = isMarkdown ? edit.new_string : stripTrailingWhitespace(edit.new_string)
    if (fileContent.includes(edit.old_string)) {
      return { ...edit, new_string: newString }
    }
    const desanitizedOld = applyDesanitization(edit.old_string)
    if (fileContent.includes(desanitizedOld)) {
      // The same replacements apply to the new string so the edit stays
      // consistent.
      return {
        ...edit,
        old_string: desanitizedOld,
        new_string: applyDesanitization(newString),
      }
    }
    return { ...edit, new_string: newString }
  })
  return { ...input, edits: normalizedEdits }
}

// ── equivalence ─────────────────────────────────────────────────────────────

function editsLiterallyEqual(edits1: FileEdit[], edits2: FileEdit[]): boolean {
  if (edits1.length !== edits2.length) return false
  return edits1.every((edit, index) => {
    const other = edits2[index]!
    return (
      edit.old_string === other.old_string &&
      edit.new_string === other.new_string &&
      edit.replace_all === other.replace_all
    )
  })
}

function applyAll(edits: FileEdit[], originalContent: string): string {
  let content = originalContent
  for (const edit of edits) {
    content =
      edit.old_string === ''
        ? edit.new_string
        : applyEditToFile(content, edit.old_string, edit.new_string, edit.replace_all)
  }
  return content
}

/**
 * Two edit lists are equivalent when literally identical or when applying
 * both to the same original content produces the same result. When both
 * applications throw, they are equivalent only when the messages match;
 * when exactly one throws, they are not equivalent.
 */
export function areFileEditsEquivalent(
  edits1: FileEdit[],
  edits2: FileEdit[],
  originalContent: string,
): boolean {
  if (editsLiterallyEqual(edits1, edits2)) return true
  let result1: { ok: true; value: string } | { ok: false; message: string }
  let result2: { ok: true; value: string } | { ok: false; message: string }
  try {
    result1 = { ok: true, value: applyAll(edits1, originalContent) }
  } catch (err) {
    result1 = { ok: false, message: err instanceof Error ? err.message : String(err) }
  }
  try {
    result2 = { ok: true, value: applyAll(edits2, originalContent) }
  } catch (err) {
    result2 = { ok: false, message: err instanceof Error ? err.message : String(err) }
  }
  if (result1.ok && result2.ok) return result1.value === result2.value
  if (!result1.ok && !result2.ok) return result1.message === result2.message
  return false
}

type FileEditsComparable = { file_path: string; edits: FileEdit[] }

/**
 * Input-level equivalence: differing paths are never equivalent; literal
 * edit equality short-circuits; otherwise the file is read at the path AS
 * GIVEN (unexpanded — a missing file is treated as empty content, with no
 * existence pre-check; any other read error propagates) and the lists are
 * compared semantically.
 */
export function areFileEditsInputsEquivalent(
  input1: FileEditsComparable,
  input2: FileEditsComparable,
): boolean {
  if (input1.file_path !== input2.file_path) return false
  if (editsLiterallyEqual(input1.edits, input2.edits)) return true
  let originalContent: string
  try {
    originalContent = readFileSyncCached(input1.file_path)
  } catch (err) {
    if (!isENOENT(err)) throw err
    originalContent = ''
  }
  return areFileEditsEquivalent(input1.edits, input2.edits, originalContent)
}
