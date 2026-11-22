import { diffArrays, structuredPatch } from 'diff'

import {
  convertLeadingTabsToSpaces,
  addLineNumbers,
  readFileSyncCached,
} from './file.js'
import { DIFF_TIMEOUT_MS, getPatchFromContents, type StructuredPatchHunk } from './diff.js'
import { isENOENT } from './errors.js'
import { logError } from './log.js'
import { expandPath } from './path.js'
import { plural } from './stringUtils.js'
import {
  LEFT_DOUBLE_CURLY_QUOTE,
  LEFT_SINGLE_CURLY_QUOTE,
  RIGHT_DOUBLE_CURLY_QUOTE,
  RIGHT_SINGLE_CURLY_QUOTE,
  straightenQuotes,
} from './curlyQuotes.js'
import { plainTypography } from './typography.js'
import { notBuilt } from '../pi/holes.js'

export type FileEdit = {
  old_string: string
  new_string: string
  replace_all: boolean
}


export { LEFT_DOUBLE_CURLY_QUOTE, LEFT_SINGLE_CURLY_QUOTE, RIGHT_DOUBLE_CURLY_QUOTE, RIGHT_SINGLE_CURLY_QUOTE }

export function normalizeQuotes(s: string): string {
  return straightenQuotes(s)
}

export function stripSequentialReadPrefixes(text: string, referenceText: string): string {
  if (text === '' || referenceText.includes(text)) return text
  const prefix = /^(\d+)(#[0-9a-f]{4})?\t/
  const lines = text.split('\n')
  const matches = lines.filter(line => line !== '' && line !== '\r').map(line => prefix.exec(line))
  if (matches.length === 0 || matches.some((match, i) => match === null || (i > 0 && Number(match[1]) !== Number(matches[i - 1]![1]) + 1))) return text
  const hashed = matches.every(match => match![2] !== undefined)
  if (!hashed && (matches.length < 2 || referenceText.split('\n').some(line => prefix.test(line)))) return text
  if (!hashed && referenceText === '') {
    throw new Error('Every line starts with a line number and a tab; Read adds those, so send the text without them. If the numbers are the file\'s data, write the first line alone, then add the rest with Edit append. Nothing was written.')
  }
  return lines.map(line => line.replace(prefix, '')).join('\n')
}


function stripTrailingWhitespace(s: string): string {
  return s.replace(/[^\S\r\n]+(?=\r\n|\r|\n|$)/g, '')
}


export const FORGIVENESS_CONTENT_DRIFT_LIMIT = 0

type ForgivingRoad = 'exact' | 'quotes' | 'characters' | 'whitespace' | 'indentation' | 'escapes'

const CONTROL_SEQUENCES: Readonly<Record<string, string>> = { n: '\n', t: '\t', r: '\r', '\\': '\\' }

function unescapeControlSequences(text: string): string {
  if (!/\\[ntr]/.test(text)) return text
  let out = ''
  for (let i = 0; i < text.length; i++) {
    const char = text[i] as string
    const next = text[i + 1]
    if (char === '\\' && next !== undefined && next in CONTROL_SEQUENCES) {
      out += CONTROL_SEQUENCES[next]
      i++
      continue
    }
    out += char
  }
  return out
}

type ActualMatch = {
  kind: 'found'
  actual: string
  index: number
  road: ForgivingRoad
  startLine: number
  endLine: number
  feedback: string | null
}

type MatchLines = { start: number; end: number }

export type ActualMatchOutcome =
  | ActualMatch
  | { kind: 'ambiguous'; road: ForgivingRoad; count: number; matches: MatchLines[] }
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
  if (road === 'escapes') return `Matched at ${span} with the \\n, \\t and \\r sequences of old_string read as the characters they spell (the file carries the characters, not the sequences); new_string was read the same way.`
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

function linesAt(fileContent: string, index: number, text: string): MatchLines {
  let start = 1
  for (let at = fileContent.indexOf('\n'); at !== -1 && at < index; at = fileContent.indexOf('\n', at + 1)) start++
  return { start, end: start + text.replace(/\n$/, '').split('\n').length - 1 }
}

function foundAt(fileContent: string, actual: string, index: number, road: ForgivingRoad, search: string): ActualMatch {
  const { start: startLine, end: endLine } = linesAt(fileContent, index, actual)
  return { kind: 'found', actual, index, road, startLine, endLine, feedback: forgivenessFeedback(road, actual, search, startLine, endLine) }
}

function locateByCharacters(fileContent: string, searchString: string): ActualMatchOutcome | null {
  const plainContent = plainTypography(fileContent)
  const plainSearch = plainTypography(searchString)
  const first = plainContent.indexOf(plainSearch)
  if (first === -1) return null
  const actual = fileContent.slice(first, first + searchString.length)
  const positions = [first]
  let differing = false
  for (let at = plainContent.indexOf(plainSearch, first + plainSearch.length); at !== -1; at = plainContent.indexOf(plainSearch, at + plainSearch.length)) {
    positions.push(at)
    if (fileContent.slice(at, at + searchString.length) !== actual) differing = true
  }
  if (differing) {
    return { kind: 'ambiguous', road: 'characters', count: positions.length, matches: positions.map(at => linesAt(fileContent, at, searchString)) }
  }
  return foundAt(fileContent, actual, first, 'characters', searchString)
}

function locateByLines(fileContent: string, searchString: string): ActualMatchOutcome {
  return notBuilt('src/utils/fileEditUtils.ts:164')
}

function locateByEscapes(fileContent: string, searchString: string): ActualMatchOutcome | null {
  const unescaped = unescapeControlSequences(searchString)
  if (unescaped === searchString) return null
  const first = fileContent.indexOf(unescaped)
  if (first === -1) return null
  const positions = [first]
  for (let at = fileContent.indexOf(unescaped, first + unescaped.length); at !== -1; at = fileContent.indexOf(unescaped, at + unescaped.length)) positions.push(at)
  if (positions.length > 1) {
    return { kind: 'ambiguous', road: 'escapes', count: positions.length, matches: positions.map(at => linesAt(fileContent, at, unescaped)) }
  }
  return foundAt(fileContent, unescaped, first, 'escapes', searchString)
}

export function locateActualString(fileContent: string, searchString: string): ActualMatchOutcome {
  const exact = fileContent.indexOf(searchString)
  if (exact !== -1) return foundAt(fileContent, searchString, exact, 'exact', searchString)
  const quoted = normalizeQuotes(fileContent).indexOf(normalizeQuotes(searchString))
  if (quoted !== -1) return foundAt(fileContent, fileContent.slice(quoted, quoted + searchString.length), quoted, 'quotes', searchString)
  const located = locateByCharacters(fileContent, searchString) ?? locateByLines(fileContent, searchString)
  if (located.kind !== 'none') return located
  return locateByEscapes(fileContent, searchString) ?? located
}

export function findActualString(fileContent: string, searchString: string): string | null {
  const outcome = locateActualString(fileContent, searchString)
  return outcome.kind === 'found' ? outcome.actual : null
}

function matchRoad(oldString: string, actualOldString: string): ForgivingRoad | null {
  if (actualOldString === oldString) return 'exact'
  if (normalizeQuotes(actualOldString) === normalizeQuotes(oldString)) return 'quotes'
  if (plainTypography(actualOldString) === plainTypography(oldString)) return 'characters'
  if (unescapeControlSequences(oldString) === actualOldString) return 'escapes'
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

function respellWhitespace(oldString: string, actualOldString: string, newString: string): string {
  return notBuilt('src/utils/fileEditUtils.ts:270')
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

export function preserveQuoteStyleCandidates(
  oldString: string,
  actualOldString: string,
  newString: string,
): { exact: string; styled: string } {
  const road = matchRoad(oldString, actualOldString)
  if (road === 'escapes') {
    return preserveQuoteStyleCandidates(actualOldString, actualOldString, unescapeControlSequences(newString))
  }
  if (road === 'whitespace' || road === 'indentation') {
    return preserveQuoteStyleCandidates(actualOldString, actualOldString, respellWhitespace(oldString, actualOldString, newString))
  }
  return {
    exact: preserveQuoteStyle(oldString, actualOldString, newString, () => false),
    styled: preserveQuoteStyle(oldString, actualOldString, newString),
  }
}

export async function preserveQuoteStyleForFile(
  filePath: string,
  fileContent: string,
  oldString: string,
  actualOldString: string,
  newString: string,
): Promise<string> {
  const { exact, styled } = preserveQuoteStyleCandidates(oldString, actualOldString, newString)
  if (exact === styled) return exact
  const { fileLanguageKind } = await import('../native-ts/color-diff/index.js')
  return fileLanguageKind(filePath, fileContent.split('\n', 1)[0]) === 'prose' ? styled : exact
}


export function applyEditToFile(
  originalContent: string,
  oldString: string,
  newString: string,
  replaceAll: boolean = false,
): string {
  const searchString = editSearchString(originalContent, oldString, newString)
  return replaceAll
    ? originalContent.replaceAll(searchString, () => newString)
    : originalContent.replace(searchString, () => newString)
}

export function editSearchString(originalContent: string, oldString: string, newString: string): string {
  return newString === '' && !oldString.endsWith('\n') && originalContent.includes(`${oldString}\n`)
    ? `${oldString}\n`
    : oldString
}

function stripTrailingNewlines(s: string): string {
  return s.replace(/\n+$/, '')
}

export function getPatchForEdits(arg0: {
  filePath: string
  fileContents: string
  edits: Array<{ old_string: string; new_string: string; replace_all?: boolean }>
}): { patch: StructuredPatchHunk[]; updatedFile: string } {
  return notBuilt('src/utils/fileEditUtils.ts:420')
}

export function getPatchForEdit(arg0: {
  filePath: string
  fileContents: string
  oldString: string
  newString: string
  replaceAll?: boolean
}): { patch: StructuredPatchHunk[]; updatedFile: string } {
  return notBuilt('src/utils/fileEditUtils.ts:471')
}


const TWO_FILE_SNIPPET_CONTEXT_LINES = 8
const TWO_FILE_SNIPPET_MAX_BYTES = 8192
const HUNK_SEPARATOR = '...'

export function getSnippetForTwoFileDiff(a: string, b: string, startLine?: number): string {
  return notBuilt('src/utils/fileEditUtils.ts:496')
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
  return notBuilt('src/utils/fileEditUtils.ts:600')
}

function areFileEditsEquivalent(
  edits1: FileEdit[],
  edits2: FileEdit[],
  originalContent: string,
): boolean {
  return notBuilt('src/utils/fileEditUtils.ts:623')
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
