import { randomBytes } from 'node:crypto'
import { notBuilt, type Unbuilt } from '../../pi/holes.js'

type HeredocExtractionResult = Unbuilt

const DELIMITER_TERMINATORS: ReadonlySet<string> = new Set([
  ' ',
  '\t',
  '\n',
  '|',
  '&',
  ';',
  '(',
  ')',
  '<',
  '>',
])

const EARLY_CLOSURE_FOLLOWERS: ReadonlySet<string> = new Set([
  ')',
  '}',
  '`',
  '|',
  '&',
  ';',
  '(',
  '<',
  '>',
])

function makeSalt(): string {
  return randomBytes(9).toString('hex')
}

type ScanState = { quote: 'plain' | 'single' | 'double'; comment: boolean }

function advanceScan(text: string, from: number, to: number, state: ScanState): void {
  return notBuilt('src/utils/bash/heredoc.ts:48')
}

function countOccurrences(text: string, token: string): number {
  let count = 0
  let index = text.indexOf(token)
  while (index !== -1) {
    count++
    index = text.indexOf(token, index + token.length)
  }
  return count
}

function precedingBackslashCount(text: string, i: number): number {
  let count = 0
  let j = i - 1
  while (j >= 0 && text[j] === '\\') {
    count++
    j--
  }
  return count
}

type Candidate = Unbuilt

export function extractHeredocs(
  command: string,
  options?: { quotedOnly?: boolean },
): HeredocExtractionResult {
  return notBuilt('src/utils/bash/heredoc.ts:116')
}

function parseCandidateAt(command: string, opIndex: number): Candidate | null {
  let i = opIndex + 2
  const dashForm = command[i] === '-'
  if (dashForm) i++
  while (command[i] === ' ' || command[i] === '\t') i++

  let literalBody: boolean
  let delimiter: string
  let afterDelimiter: number

  const quoteChar = command[i]
  if (quoteChar === "'" || quoteChar === '"') {
    let j = i + 1
    let body = ''
    if (command[j] === '\\') {
      body += '\\'
      j++
    }
    const wordStart = j
    while (j < command.length && /[A-Za-z0-9_]/.test(command[j] as string)) j++
    if (j === wordStart && body === '') return null
    if (command[j] !== quoteChar) return null
    body += command.slice(wordStart, j)
    delimiter = body
    literalBody = true
    afterDelimiter = j + 1
  } else {
    let j = i
    let escaped = false
    if (command[j] === '\\') {
      escaped = true
      j++
    }
    const wordStart = j
    while (j < command.length && /[A-Za-z0-9_]/.test(command[j] as string)) j++
    if (j === wordStart) return null
    delimiter = command.slice(wordStart, j)
    literalBody = escaped
    afterDelimiter = j
  }

  const terminator = afterDelimiter < command.length ? command[afterDelimiter] : undefined
  if (terminator !== undefined && !DELIMITER_TERMINATORS.has(terminator)) return null

  const lineScan: ScanState = { quote: 'plain', comment: false }
  let newlineIndex = -1
  for (let k = afterDelimiter; k < command.length; k++) {
    advanceScan(command, k, k + 1, lineScan)
    if (command[k] === '\n' && lineScan.quote === 'plain') {
      newlineIndex = k
      if (precedingBackslashCount(command, k) % 2 === 1) return null
      break
    }
  }
  if (newlineIndex === -1) return null

  const found = findClosingDelimiter(command, newlineIndex + 1, delimiter, dashForm)
  if (found === null) return null

  return {
    operatorStartIndex: opIndex,
    operatorEndIndex: afterDelimiter,
    delimiter,
    dashForm,
    literalBody,
    bodyStartIndex: newlineIndex,
    bodyEndIndex: found.delimiterLineStart,
    contentEndIndex: found.contentEndIndex,
    skipped: false,
  }
}

function findClosingDelimiter(
  command: string,
  bodyStart: number,
  delimiter: string,
  dashForm: boolean,
): { delimiterLineStart: number; contentEndIndex: number } | null {
  let lineStart = bodyStart
  while (lineStart <= command.length) {
    let lineEnd = command.indexOf('\n', lineStart)
    if (lineEnd === -1) lineEnd = command.length
    let line = command.slice(lineStart, lineEnd)
    let stripped = line
    if (dashForm) stripped = stripped.replace(/^\t+/, '')

    if (stripped === delimiter) {
      return { delimiterLineStart: lineStart, contentEndIndex: lineEnd }
    }
    if (stripped.startsWith(delimiter) && stripped.length > delimiter.length) {
      const next = stripped[delimiter.length]
      if (next !== undefined && EARLY_CLOSURE_FOLLOWERS.has(next)) {
        return null
      }
    }
    if (lineEnd === command.length) break
    lineStart = lineEnd + 1
  }
  return null
}
