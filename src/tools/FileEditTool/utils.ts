import { diffArrays, structuredPatch } from 'diff'

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
import {
  LEFT_DOUBLE_CURLY_QUOTE,
  LEFT_SINGLE_CURLY_QUOTE,
  RIGHT_DOUBLE_CURLY_QUOTE,
  RIGHT_SINGLE_CURLY_QUOTE,
  straightenQuotes,
} from '../../utils/curlyQuotes.js'
import { plainTypography } from '../../utils/typography.js'
import type { FileEdit } from './types.js'


export { LEFT_DOUBLE_CURLY_QUOTE, LEFT_SINGLE_CURLY_QUOTE, RIGHT_DOUBLE_CURLY_QUOTE, RIGHT_SINGLE_CURLY_QUOTE }

export function normalizeQuotes(s: string): string {
  return straightenQuotes(s)
}


export function stripTrailingWhitespace(s: string): string {
  return s.replace(/[^\S\r\n]+(?=\r\n|\r|\n|$)/g, '')
}


export const FORGIVENESS_CONTENT_DRIFT_LIMIT = 0

export type ForgivingRoad = 'exact' | 'quotes' | 'characters' | 'whitespace' | 'indentation'

export type ActualMatch = {
  kind: 'found'
  actual: string
  index: number
  road: ForgivingRoad
  startLine: number
  endLine: number
  feedback: string | null
}

export type ActualMatchOutcome =
  | ActualMatch
  | { kind: 'ambiguous'; road: ForgivingRoad; count: number }
  | { kind: 'none' }

const LEADING_WHITESPACE = /^\s*/

function leadingWhitespace(line: string): string {
  return (LEADING_WHITESPACE.exec(line) as RegExpExecArray)[0]
}

function describeIndentation(whitespace: string): string {
  if (whitespace === '') return 'no indentation'
  const tabs = whitespace.split('\t').length - 1
  const spaces = whitespace.split(' ').length - 1
  const other = whitespace.length - tabs - spaces
  if (other > 0) return `${whitespace.length} whitespace ${plural(whitespace.length, 'character')}`
  const parts: string[] = []
  if (tabs > 0) parts.push(`${tabs} ${plural(tabs, 'tab')}`)
  if (spaces > 0) parts.push(`${spaces} ${plural(spaces, 'space')}`)
  return parts.join(' and ')
}

function lineSpan(startLine: number, endLine: number): string {
  return startLine === endLine ? `line ${startLine}` : `lines ${startLine}-${endLine}`
}

function forgivenessFeedback(road: ForgivingRoad, actual: string, search: string, startLine: number, endLine: number): string | null {
  if (road === 'exact' || road === 'quotes') return null
  const span = lineSpan(startLine, endLine)
  if (road === 'characters') return `Matched with the file's dash/space characters at ${span}.`
  const actualLines = actual.split('\n')
  const searchLines = search.split('\n')
  const characters = actualLines.some((line, i) => line.trim() !== (searchLines[i] ?? '').trim())
  const also = characters ? ' and dash/space characters' : ''
  if (road === 'whitespace') return `Matched with the file's trailing whitespace${also} at ${span}.`
  const differing = actualLines.findIndex((line, i) => leadingWhitespace(line) !== leadingWhitespace(searchLines[i] ?? ''))
  const at = Math.max(differing, 0)
  const fileIndent = leadingWhitespace(actualLines[at] ?? '')
  const typedIndent = leadingWhitespace(searchLines[at] ?? '')
  const file = fileIndent === '' ? 'has no indentation' : `indents with ${describeIndentation(fileIndent)}`
  return `Matched with the file's indentation${also} at ${span}: the file ${file} where old_string used ${describeIndentation(typedIndent)}.`
}

function foundAt(fileContent: string, actual: string, index: number, road: ForgivingRoad, search: string): ActualMatch {
  let startLine = 1
  for (let at = fileContent.indexOf('\n'); at !== -1 && at < index; at = fileContent.indexOf('\n', at + 1)) startLine++
  const endLine = startLine + actual.replace(/\n$/, '').split('\n').length - 1
  return { kind: 'found', actual, index, road, startLine, endLine, feedback: forgivenessFeedback(road, actual, search, startLine, endLine) }
}

function locateByCharacters(fileContent: string, searchString: string): ActualMatchOutcome | null {
  const plainContent = plainTypography(fileContent)
  const plainSearch = plainTypography(searchString)
  const first = plainContent.indexOf(plainSearch)
  if (first === -1) return null
  const actual = fileContent.slice(first, first + searchString.length)
  let count = 1
  let differing = false
  for (let at = plainContent.indexOf(plainSearch, first + plainSearch.length); at !== -1; at = plainContent.indexOf(plainSearch, at + plainSearch.length)) {
    count++
    if (fileContent.slice(at, at + searchString.length) !== actual) differing = true
  }
  if (differing) return { kind: 'ambiguous', road: 'characters', count }
  return foundAt(fileContent, actual, first, 'characters', searchString)
}

function locateByLines(fileContent: string, searchString: string): ActualMatchOutcome {
  const terminated = searchString.endsWith('\n')
  const body = terminated ? searchString.slice(0, -1) : searchString
  if (body.trim() === '') return { kind: 'none' }
  const searchLines = body.split('\n')
  const fileLines = fileContent.split('\n')
  const lastWindowStart = fileLines.length - searchLines.length - (terminated ? 1 : 0)
  if (lastWindowStart < 0) return { kind: 'none' }
  const offsets: number[] = new Array(fileLines.length)
  let offset = 0
  for (let i = 0; i < fileLines.length; i++) {
    offsets[i] = offset
    offset += (fileLines[i] as string).length + 1
  }
  const plainFile = fileLines.map(line => plainTypography(line))
  const plainSearch = searchLines.map(line => plainTypography(line))
  const roads: Array<[ForgivingRoad, (line: string) => string]> = [
    ['whitespace', line => line.trimEnd()],
    ['indentation', line => line.trim()],
  ]
  for (const [road, fold] of roads) {
    const folded = plainFile.map(fold)
    const wanted = plainSearch.map(fold)
    const windows: number[] = []
    for (let start = 0; start <= lastWindowStart; start++) {
      let drift = 0
      for (let k = 0; k < wanted.length; k++) {
        if (folded[start + k] !== wanted[k]) {
          drift++
          if (drift > FORGIVENESS_CONTENT_DRIFT_LIMIT) break
        }
      }
      if (drift <= FORGIVENESS_CONTENT_DRIFT_LIMIT) windows.push(start)
    }
    if (windows.length === 0) continue
    const sliceAt = (start: number): string => {
      const last = start + searchLines.length - 1
      const end = (offsets[last] as number) + (fileLines[last] as string).length + (terminated ? 1 : 0)
      return fileContent.slice(offsets[start] as number, end)
    }
    const actual = sliceAt(windows[0] as number)
    if (windows.some(start => sliceAt(start) !== actual)) return { kind: 'ambiguous', road, count: windows.length }
    return foundAt(fileContent, actual, offsets[windows[0] as number] as number, road, searchString)
  }
  return { kind: 'none' }
}

export function locateActualString(fileContent: string, searchString: string): ActualMatchOutcome {
  const exact = fileContent.indexOf(searchString)
  if (exact !== -1) return foundAt(fileContent, searchString, exact, 'exact', searchString)
  const quoted = normalizeQuotes(fileContent).indexOf(normalizeQuotes(searchString))
  if (quoted !== -1) return foundAt(fileContent, fileContent.slice(quoted, quoted + searchString.length), quoted, 'quotes', searchString)
  return locateByCharacters(fileContent, searchString) ?? locateByLines(fileContent, searchString)
}

export function findActualString(fileContent: string, searchString: string): string | null {
  const outcome = locateActualString(fileContent, searchString)
  return outcome.kind === 'found' ? outcome.actual : null
}

export function matchRoad(oldString: string, actualOldString: string): ForgivingRoad | null {
  if (actualOldString === oldString) return 'exact'
  if (normalizeQuotes(actualOldString) === normalizeQuotes(oldString)) return 'quotes'
  if (plainTypography(actualOldString) === plainTypography(oldString)) return 'characters'
  const actualLines = actualOldString.split('\n')
  const oldLines = oldString.split('\n')
  if (actualLines.length !== oldLines.length) return null
  const plainActual = actualLines.map(line => plainTypography(line))
  const plainOld = oldLines.map(line => plainTypography(line))
  if (plainActual.every((line, i) => line.trimEnd() === (plainOld[i] as string).trimEnd())) return 'whitespace'
  if (plainActual.every((line, i) => line.trim() === (plainOld[i] as string).trim())) return 'indentation'
  return null
}

function reindentLine(line: string, indents: Map<string, string>): string {
  if (line.trim() === '') return line
  const typed = leadingWhitespace(line)
  const rest = line.slice(typed.length)
  const known = indents.get(typed)
  if (known !== undefined) return known + rest
  let best: string | null = null
  for (const key of indents.keys()) {
    if (typed.startsWith(key) && (best === null || key.length > best.length)) best = key
  }
  if (best === null) return line
  return (indents.get(best) as string) + typed.slice(best.length) + rest
}

export function respellWhitespace(oldString: string, actualOldString: string, newString: string): string {
  if (newString === '') return newString
  const oldLines = oldString.split('\n')
  const actualLines = actualOldString.split('\n')
  const indents = new Map<string, string>()
  for (let i = 0; i < oldLines.length; i++) {
    const typed = oldLines[i] as string
    if (typed.trim() === '') continue
    const key = leadingWhitespace(typed)
    if (!indents.has(key)) indents.set(key, leadingWhitespace(actualLines[i] ?? ''))
  }
  const out: string[] = []
  let at = 0
  for (const part of diffArrays(oldLines, newString.split('\n'))) {
    if (part.removed) {
      at += part.value.length
      continue
    }
    if (part.added) {
      for (const line of part.value) out.push(reindentLine(line, indents))
      continue
    }
    for (let k = 0; k < part.value.length; k++) out.push(actualLines[at + k] ?? (part.value[k] as string))
    at += part.value.length
  }
  return out.join('\n')
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
  styleQuotes: () => boolean = () => true,
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
    (replaced.includes(LEFT_DOUBLE_CURLY_QUOTE) ||
      replaced.includes(RIGHT_DOUBLE_CURLY_QUOTE) ||
      replaced.includes(LEFT_SINGLE_CURLY_QUOTE) ||
      replaced.includes(RIGHT_SINGLE_CURLY_QUOTE)) &&
    styleQuotes()
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

export async function preserveQuoteStyleForFile(
  filePath: string,
  fileContent: string,
  oldString: string,
  actualOldString: string,
  newString: string,
): Promise<string> {
  const road = matchRoad(oldString, actualOldString)
  if (road === 'whitespace' || road === 'indentation') {
    const respelled = respellWhitespace(oldString, actualOldString, newString)
    return preserveQuoteStyleForFile(filePath, fileContent, actualOldString, actualOldString, respelled)
  }
  const exact = preserveQuoteStyle(oldString, actualOldString, newString, () => false)
  const styled = preserveQuoteStyle(oldString, actualOldString, newString)
  if (exact === styled) return exact
  const { fileLanguageKind } = await import('../../native-ts/color-diff/index.js')
  return fileLanguageKind(filePath, fileContent.split('\n', 1)[0]) === 'prose' ? styled : exact
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
