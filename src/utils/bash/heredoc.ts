import { randomBytes } from 'node:crypto'

type HeredocInfo = {
  fullText: string
  delimiter: string
  operatorStartIndex: number
  operatorEndIndex: number
  contentStartIndex: number
  contentEndIndex: number
}

type HeredocExtractionResult = {
  processedCommand: string
  heredocs: Map<string, HeredocInfo>
}

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
  for (let i = from; i < to; i++) {
    const ch = text[i]
    if (state.comment) {
      if (ch === '\n') state.comment = false
      continue
    }
    if (state.quote === 'single') {
      if (ch === "'") state.quote = 'plain'
      continue
    }
    if (state.quote === 'double') {
      if (ch === '"' && precedingBackslashCount(text, i) % 2 === 0) {
        state.quote = 'plain'
      }
      continue
    }
    if (ch === "'" && precedingBackslashCount(text, i) % 2 === 0) {
      state.quote = 'single'
    } else if (ch === '"' && precedingBackslashCount(text, i) % 2 === 0) {
      state.quote = 'double'
    } else if (ch === '#' && (i === 0 || DELIMITER_TERMINATORS.has(text[i - 1]!))) {
      state.comment = true
    }
  }
}

function advanceSkippingBodies(
  text: string,
  from: number,
  to: number,
  state: ScanState,
  candidates: readonly Candidate[],
): void {
  const overlapping = candidates
    .filter(c => c.bodyStartIndex + 1 < to && c.contentEndIndex > from)
    .sort((a, b) => a.bodyStartIndex - b.bodyStartIndex)
  let pos = from
  for (const c of overlapping) {
    const bodyStart = c.bodyStartIndex + 1
    if (bodyStart > pos) {
      advanceScan(text, pos, Math.min(to, bodyStart), state)
    }
    pos = Math.max(pos, Math.min(to, c.contentEndIndex))
  }
  if (pos < to) {
    advanceScan(text, pos, to, state)
  }
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

type Candidate = {
  operatorStartIndex: number
  operatorEndIndex: number
  delimiter: string
  dashForm: boolean
  literalBody: boolean
  bodyStartIndex: number
  contentEndIndex: number
  skipped: boolean
}

export function extractHeredocs(
  command: string,
  options?: { quotedOnly?: boolean },
): HeredocExtractionResult {
  const empty = (): HeredocExtractionResult => ({ processedCommand: command, heredocs: new Map() })
  const firstOp = command.indexOf('<<')
  if (firstOp === -1) return empty()
  if (command.includes("$'") || command.includes('$"')) return empty()
  const prefix = command.slice(0, firstOp)
  if (prefix.includes('`') || countOccurrences(prefix, '((') > countOccurrences(prefix, '))')) {
    return empty()
  }

  const quotedOnly = options?.quotedOnly === true
  const state: ScanState = { quote: 'plain', comment: false }
  const candidates: Candidate[] = []
  let scanPos = 0
  let searchFrom = 0

  while (searchFrom < command.length) {
    const opIndex = command.indexOf('<<', searchFrom)
    if (opIndex === -1) break
    searchFrom = opIndex + 2

    if (command[opIndex - 1] === '<' || command[opIndex + 2] === '<') continue
    if (candidates.some(c => opIndex > c.bodyStartIndex && opIndex < c.contentEndIndex)) continue

    advanceSkippingBodies(command, scanPos, opIndex, state, candidates)
    scanPos = opIndex

    if (state.quote !== 'plain' || state.comment) continue
    if (precedingBackslashCount(command, opIndex) % 2 === 1) continue

    const candidate = parseCandidateAt(command, opIndex)
    if (candidate === null) continue
    if (quotedOnly && !candidate.literalBody) {
      candidate.skipped = true
    }
    candidates.push(candidate)
  }

  const active = candidates.filter(c => !c.skipped)
  if (active.length === 0) return empty()

  const survivors = active.filter(
    c =>
      !active.some(
        other =>
          other !== c &&
          c.operatorStartIndex > other.bodyStartIndex &&
          c.operatorStartIndex < other.contentEndIndex,
      ),
  )
  if (survivors.length === 0) return empty()

  const seenBodyStarts = new Set<number>()
  for (const c of survivors) {
    if (seenBodyStarts.has(c.bodyStartIndex)) return empty()
    seenBodyStarts.add(c.bodyStartIndex)
  }

  const salt = makeSalt()
  const byOpStart = [...survivors].sort((a, b) => a.operatorStartIndex - b.operatorStartIndex)
  const entries = byOpStart.map((candidate, index) => ({
    candidate,
    placeholder: `__MERCURY_HEREDOC_${salt}_${index}__`,
  }))

  const heredocs = new Map<string, HeredocInfo>()
  for (const { candidate, placeholder } of entries) {
    heredocs.set(placeholder, {
      fullText:
        command.slice(candidate.operatorStartIndex, candidate.operatorEndIndex) +
        command.slice(candidate.bodyStartIndex, candidate.contentEndIndex),
      delimiter: candidate.delimiter,
      operatorStartIndex: candidate.operatorStartIndex,
      operatorEndIndex: candidate.operatorEndIndex,
      contentStartIndex: candidate.bodyStartIndex,
      contentEndIndex: candidate.contentEndIndex,
    })
  }

  let processedCommand = command
  const byContentEndDesc = [...entries].sort(
    (a, b) => b.candidate.contentEndIndex - a.candidate.contentEndIndex,
  )
  for (const { candidate, placeholder } of byContentEndDesc) {
    const between = command.slice(candidate.operatorEndIndex, candidate.bodyStartIndex)
    processedCommand =
      processedCommand.slice(0, candidate.operatorStartIndex) +
      placeholder +
      between +
      processedCommand.slice(candidate.contentEndIndex)
  }

  return { processedCommand, heredocs }
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
    while (j < command.length && /[A-Za-z0-9_]/.test(command[j]!)) j++
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
    while (j < command.length && /[A-Za-z0-9_]/.test(command[j]!)) j++
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

  const contentEndIndex = findClosingDelimiter(command, newlineIndex + 1, delimiter, dashForm)
  if (contentEndIndex === null) return null

  return {
    operatorStartIndex: opIndex,
    operatorEndIndex: afterDelimiter,
    delimiter,
    dashForm,
    literalBody,
    bodyStartIndex: newlineIndex,
    contentEndIndex,
    skipped: false,
  }
}

function findClosingDelimiter(
  command: string,
  bodyStart: number,
  delimiter: string,
  dashForm: boolean,
): number | null {
  let lineStart = bodyStart
  while (lineStart <= command.length) {
    let lineEnd = command.indexOf('\n', lineStart)
    if (lineEnd === -1) lineEnd = command.length
    const line = command.slice(lineStart, lineEnd)
    let stripped = line
    if (dashForm) stripped = stripped.replace(/^\t+/, '')

    if (stripped === delimiter) {
      return lineEnd
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
