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


export const LEFT_SINGLE_CURLY_QUOTE = '‘'
export const RIGHT_SINGLE_CURLY_QUOTE = '’'
export const LEFT_DOUBLE_CURLY_QUOTE = '“'
export const RIGHT_DOUBLE_CURLY_QUOTE = '”'

export function normalizeQuotes(s: string): string {
  return s
    .replaceAll(LEFT_SINGLE_CURLY_QUOTE, "'")
    .replaceAll(RIGHT_SINGLE_CURLY_QUOTE, "'")
    .replaceAll(LEFT_DOUBLE_CURLY_QUOTE, '"')
    .replaceAll(RIGHT_DOUBLE_CURLY_QUOTE, '"')
}


export function stripTrailingWhitespace(s: string): string {
  return s.replace(/[^\S\r\n]+(?=\r\n|\r|\n|$)/g, '')
}


export function findActualString(fileContent: string, searchString: string): string | null {
  if (fileContent.includes(searchString)) return searchString
  const index = normalizeQuotes(fileContent).indexOf(normalizeQuotes(searchString))
  if (index === -1) return null
  return fileContent.slice(index, index + searchString.length)
}

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
    previous === '—' ||
    previous === '–'
  )
}

const LETTER = /\p{L}/u

function isContraction(text: string, index: number): boolean {
  const before = index > 0 ? (text[index - 1] as string) : ''
  const after = index + 1 < text.length ? (text[index + 1] as string) : ''
  return LETTER.test(before) && LETTER.test(after)
}

export function preserveQuoteStyle(
  oldString: string,
  actualOldString: string,
  newString: string,
): string {
  if (actualOldString.length !== oldString.length) return newString
  const limit = Math.min(oldString.length, newString.length)
  let head = 0
  while (head < limit && oldString[head] === newString[head]) head++
  let tail = 0
  while (tail < limit - head && oldString[oldString.length - 1 - tail] === newString[newString.length - 1 - tail]) tail++
  const lineStart = head === 0 ? 0 : actualOldString.lastIndexOf('\n', head - 1) + 1
  const lineEnd = actualOldString.indexOf('\n', actualOldString.length - tail)
  const replaced = actualOldString.slice(lineStart, lineEnd === -1 ? actualOldString.length : lineEnd)
  const styled =
    replaced.includes(LEFT_DOUBLE_CURLY_QUOTE) ||
    replaced.includes(RIGHT_DOUBLE_CURLY_QUOTE) ||
    replaced.includes(LEFT_SINGLE_CURLY_QUOTE) ||
    replaced.includes(RIGHT_SINGLE_CURLY_QUOTE)
  const end = newString.length - tail
  let result = actualOldString.slice(0, head)
  for (let i = head; i < end; i++) {
    const char = newString[i] as string
    if (char === '"' && styled) {
      result += isOpeningPosition(newString, i) ? LEFT_DOUBLE_CURLY_QUOTE : RIGHT_DOUBLE_CURLY_QUOTE
      continue
    }
    if (char === "'" && styled) {
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
  return result + actualOldString.slice(actualOldString.length - tail)
}


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

export function getPatchForEdits({
  filePath,
  fileContents,
  edits,
}: {
  filePath: string
  fileContents: string
  edits: Array<{ old_string: string; new_string: string; replace_all?: boolean }>
}): { patch: StructuredPatchHunk[]; updatedFile: string } {
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


const TWO_FILE_SNIPPET_CONTEXT_LINES = 8
const TWO_FILE_SNIPPET_MAX_BYTES = 8192
const HUNK_SEPARATOR = '...'

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


type FileEditsInput = {
  file_path: string
  edits: Array<{ old_string?: string; new_string?: string; replace_all?: boolean }>
}

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
    if (edit.old_string === undefined || edit.new_string === undefined) return edit
    const newString = isMarkdown ? edit.new_string : stripTrailingWhitespace(edit.new_string)
    if (fileContent.includes(edit.old_string)) {
      return { ...edit, new_string: newString }
    }
    const desanitizedOld = applyDesanitization(edit.old_string)
    if (fileContent.includes(desanitizedOld)) {
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
