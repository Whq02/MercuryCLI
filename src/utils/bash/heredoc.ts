import { randomBytes } from 'node:crypto'

export type HeredocInfo = {
  fullText: string
  delimiter: string
  operatorStartIndex: number
  operatorEndIndex: number
  contentStartIndex: number
  contentEndIndex: number
}

export type HeredocExtractionResult = {
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
    if (ch === '\n') {
      state.comment = false
    }
    if (state.quote === 'single') {
      if (ch === "'") state.quote = 'plain'
      continue
    }
    if (state.quote === 'double') {
      if (ch === '\\') {
        i++
        continue
      }
      if (ch === '"') state.quote = 'plain'
      continue
    }
    if (ch === '\\') {
      i++
      continue
    }
    if (ch === "'") {
      state.quote = 'single'
      continue
    }
    if (ch === '"') {
      state.quote = 'double'
      continue
    }
    if (ch === '#') {
      state.comment = true
    }
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
  bodyEndIndex: number
  contentEndIndex: number
  skipped: boolean
}

export function extractHeredocs(
  command: string,
  options?: { quotedOnly?: boolean },
): HeredocExtractionResult {
  const empty: HeredocExtractionResult = { processedCommand: command, heredocs: new Map() }

  if (!command.includes('<<')) return empty
  if (command.includes("$'") || command.includes('$"')) return empty

  const firstHeredoc = command.indexOf('<<')
  const beforeFirst = command.slice(0, firstHeredoc)
  if (beforeFirst.includes('`')) return empty
  if (countOccurrences(beforeFirst, '((') > countOccurrences(beforeFirst, '))')) return empty

  const quotedOnly = options?.quotedOnly === true
  const scan: ScanState = { quote: 'plain', comment: false }
  let scanIndex = 0
  const candidates: Candidate[] = []

  for (let i = 0; i + 1 < command.length; i++) {
    if (!(command[i] === '<' && command[i + 1] === '<')) continue
    if (command[i - 1] === '<' || command[i + 2] === '<') continue

    advanceScan(command, scanIndex, i, scan)
    scanIndex = i

    if (scan.quote !== 'plain' || scan.comment) continue
    if (precedingBackslashCount(command, i) % 2 === 1) continue
    if (candidates.some(c => c.skipped && i >= c.bodyStartIndex && i < c.contentEndIndex)) continue

    const parsed = parseCandidateAt(command, i)
    if (parsed === null) continue

    if (quotedOnly && !parsed.literalBody) {
      candidates.push({ ...parsed, skipped: true })
      continue
    }
    candidates.push(parsed)
  }

  const survivors = candidates.filter(c => !c.skipped)
  if (survivors.length === 0) return empty

  const filtered = survivors.filter(
    c =>
      !survivors.some(
        other =>
          other !== c &&
          c.operatorStartIndex > other.bodyStartIndex &&
          c.operatorStartIndex < other.contentEndIndex,
      ),
  )
  if (filtered.length === 0) return empty

  const bodyStarts = new Set<number>()
  for (const c of filtered) {
    if (bodyStarts.has(c.bodyStartIndex)) return empty
    bodyStarts.add(c.bodyStartIndex)
  }

  const salt = makeSalt()
  const ordered = [...filtered].sort((a, b) => a.operatorStartIndex - b.operatorStartIndex)
  const placeholders = new Map<Candidate, string>()
  ordered.forEach((c, index) => {
    placeholders.set(c, `__MERCURY_HEREDOC_${salt}_${index}__`)
  })

  const heredocs = new Map<string, HeredocInfo>()
  let processed = command
  const byBodyEndDesc = [...filtered].sort((a, b) => b.contentEndIndex - a.contentEndIndex)
  for (const c of byBodyEndDesc) {
    const placeholder = placeholders.get(c) as string
    const operatorText = command.slice(c.operatorStartIndex, c.operatorEndIndex)
    const restorationText = operatorText + command.slice(c.bodyStartIndex, c.contentEndIndex)
    heredocs.set(placeholder, {
      fullText: restorationText,
      delimiter: c.delimiter,
      operatorStartIndex: c.operatorStartIndex,
      operatorEndIndex: c.operatorEndIndex,
      contentStartIndex: c.bodyStartIndex,
      contentEndIndex: c.contentEndIndex,
    })
    processed =
      processed.slice(0, c.operatorStartIndex) +
      placeholder +
      processed.slice(c.operatorEndIndex, c.bodyStartIndex) +
      processed.slice(c.contentEndIndex)
  }

  return { processedCommand: processed, heredocs }
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

export function restoreHeredocs(parts: string[], heredocs: Map<string, HeredocInfo>): string[] {
  if (heredocs.size === 0) return parts
  return parts.map(part => {
    let restored = part
    for (const [placeholder, info] of heredocs) {
      restored = restored.split(placeholder).join(info.fullText)
    }
    return restored
  })
}
