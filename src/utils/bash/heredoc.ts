/**
 * Heredoc detection, extraction to opaque placeholders, and restoration.
 *
 * The shell tokenizer reads `<<` as two `<` redirects, which breaks command
 * splitting; this module lifts each heredoc out to a placeholder before
 * tokenisation and puts it back afterwards. The safety posture is: when in
 * doubt, extract nothing. Passing a command through unextracted is safe (the
 * tokenizer either fails, producing whole-command treatment, or each
 * apparent subcommand requires approval); extracting with wrong boundaries
 * hides executable text from every validator. Every bail below exists for
 * that reason.
 */
import { randomBytes } from 'node:crypto'

/** Where one heredoc lives in the source. Index fields are plain JS string indices. */
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

/** Metacharacters that may legitimately follow a heredoc delimiter. */
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

/** Characters that, right after a body-line delimiter match, close it early. */
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

/** Fresh per-call salt so literal placeholder-shaped text cannot forge one. */
function makeSalt(): string {
  return randomBytes(9).toString('hex')
}

/** A quote/comment scan state carried forward incrementally over the source. */
type ScanState = { quote: 'plain' | 'single' | 'double'; comment: boolean }

/**
 * Advance the incremental bash-semantics quote/comment scan across
 * `text[from, to)`. Quote tracking is comment-blind — an unquoted `#` sets
 * comment state but never suppresses quote updates, or a `#` inside a word
 * would desynchronise the state. Any physical newline clears comment state,
 * including inside quotes.
 */
function advanceScan(text: string, from: number, to: number, state: ScanState): void {
  for (let i = from; i < to; i++) {
    const ch = text[i]
    if (ch === '\n') {
      state.comment = false
      // A newline does not itself change quote state (bash allows multi-line
      // quoted strings), so fall through to the quote handling below.
    }
    if (state.quote === 'single') {
      if (ch === "'") state.quote = 'plain'
      continue
    }
    if (state.quote === 'double') {
      if (ch === '\\') {
        i++ // escapes the next character inside double quotes
        continue
      }
      if (ch === '"') state.quote = 'plain'
      continue
    }
    // Unquoted.
    if (ch === '\\') {
      i++ // a run of backslashes escapes the next character when odd; stepping
      continue // one keeps parity correct for the following character
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

/** Count occurrences of a two-character token in a slice of text. */
function countOccurrences(text: string, token: string): number {
  let count = 0
  let index = text.indexOf(token)
  while (index !== -1) {
    count++
    index = text.indexOf(token, index + token.length)
  }
  return count
}

/** Backslashes immediately preceding index `i`. */
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

/**
 * Extract heredocs from a command. Returns the command with each surviving
 * heredoc replaced by a salted placeholder, plus the map from placeholder to
 * its recorded info. `quotedOnly` leaves unquoted heredocs in place (their
 * bodies can hold substitutions bash really runs, which must stay visible)
 * while still recording their ranges so overlap checks can reject quoted
 * heredocs living inside them.
 */
export function extractHeredocs(
  command: string,
  options?: { quotedOnly?: boolean },
): HeredocExtractionResult {
  const empty: HeredocExtractionResult = { processedCommand: command, heredocs: new Map() }

  // Fast path and whole-command bails.
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
    // Never a here-string, never `<<<`.
    if (command[i - 1] === '<' || command[i + 2] === '<') continue

    advanceScan(command, scanIndex, i, scan)
    scanIndex = i

    // Per-candidate skips that do not consume this operator for the scan.
    if (scan.quote !== 'plain' || scan.comment) continue
    if (precedingBackslashCount(command, i) % 2 === 1) continue
    // Inside a previously-skipped heredoc's body range, `<<` is just text.
    if (candidates.some(c => c.skipped && i >= c.bodyStartIndex && i < c.contentEndIndex)) continue

    const parsed = parseCandidateAt(command, i)
    if (parsed === null) continue

    if (quotedOnly && !parsed.literalBody) {
      // Record the range so overlap checks see it, but do not extract it.
      candidates.push({ ...parsed, skipped: true })
      continue
    }
    candidates.push(parsed)
  }

  const survivors = candidates.filter(c => !c.skipped)
  if (survivors.length === 0) return empty

  // Drop any heredoc whose operator starts strictly inside another
  // survivor's body range.
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

  // Two survivors sharing a body start would corrupt the index arithmetic.
  const bodyStarts = new Set<number>()
  for (const c of filtered) {
    if (bodyStarts.has(c.bodyStartIndex)) return empty
    bodyStarts.add(c.bodyStartIndex)
  }

  // Assign ascending index components in source order, then replace from the
  // last body end backwards so earlier offsets stay valid.
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
    // Restoration text is the operator plus the body through the closing
    // delimiter (from the body-start newline onward).
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
      // Keep everything up to the operator, the placeholder, then the
      // same-line text between the operator and the body, then the rest —
      // the body through the closing delimiter is removed.
      processed.slice(0, c.operatorStartIndex) +
      placeholder +
      processed.slice(c.operatorEndIndex, c.bodyStartIndex) +
      processed.slice(c.contentEndIndex)
  }

  return { processedCommand: processed, heredocs }
}

/**
 * Parse one heredoc candidate whose `<<` starts at `opIndex`. Returns null
 * for any per-candidate skip that means "not a heredoc here". A returned
 * candidate always carries a valid body range; `skipped` is set by the
 * caller for quoted-only recording.
 */
function parseCandidateAt(command: string, opIndex: number): Candidate | null {
  let i = opIndex + 2
  const dashForm = command[i] === '-'
  if (dashForm) i++
  // Only spaces and tabs may separate `<<` from the delimiter.
  while (command[i] === ' ' || command[i] === '\t') i++

  let literalBody: boolean
  let delimiter: string
  let afterDelimiter: number

  const quoteChar = command[i]
  if (quoteChar === "'" || quoteChar === '"') {
    // Quoted delimiter: a leading backslash inside is part of the delimiter.
    let j = i + 1
    let body = ''
    if (command[j] === '\\') {
      body += '\\'
      j++
    }
    const wordStart = j
    while (j < command.length && /[A-Za-z0-9_]/.test(command[j] as string)) j++
    if (j === wordStart && body === '') return null
    if (command[j] !== quoteChar) return null // closing quote must match (`<<"EO F"`)
    body += command.slice(wordStart, j)
    delimiter = body
    literalBody = true
    afterDelimiter = j + 1
  } else {
    // Unquoted: a leading backslash is an escape, not part of the delimiter.
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
    literalBody = escaped // an escaped delimiter means a literal body
    afterDelimiter = j
  }

  // The character right after the delimiter must be a bash metacharacter.
  const terminator = afterDelimiter < command.length ? command[afterDelimiter] : undefined
  if (terminator !== undefined && !DELIMITER_TERMINATORS.has(terminator)) return null

  // The body starts at the first newline that is NOT inside a quoted string,
  // scanning from the end of the delimiter with bash quote semantics. The
  // body text INCLUDES that newline (spec: "from the body-start newline"),
  // so the operator plus body reconstructs the original exactly when the
  // operator was last on its line.
  const lineScan: ScanState = { quote: 'plain', comment: false }
  let newlineIndex = -1
  for (let k = afterDelimiter; k < command.length; k++) {
    advanceScan(command, k, k + 1, lineScan)
    if (command[k] === '\n' && lineScan.quote === 'plain') {
      newlineIndex = k
      // The same-line content must not end in an odd backslash run
      // (continuation): that would fold a real command into the body.
      if (precedingBackslashCount(command, k) % 2 === 1) return null
      break
    }
  }
  if (newlineIndex === -1) return null // no unquoted newline: no body

  // Find the closing delimiter line, scanning body lines from after the newline.
  const found = findClosingDelimiter(command, newlineIndex + 1, delimiter, dashForm)
  if (found === null) return null

  return {
    operatorStartIndex: opIndex,
    operatorEndIndex: afterDelimiter,
    delimiter,
    dashForm,
    literalBody,
    // contentStartIndex is the newline itself so the recorded body carries it.
    bodyStartIndex: newlineIndex,
    bodyEndIndex: found.delimiterLineStart,
    contentEndIndex: found.contentEndIndex,
    skipped: false,
  }
}

/**
 * Locate the closing delimiter line at or after `bodyStart`. The closing
 * line is the delimiter alone (for `<<-`, after stripping leading tabs). A
 * line that begins with the delimiter but is longer and whose next character
 * is an early-closure follower abandons the heredoc (null).
 */
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
      // Content runs up to and including this delimiter line.
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

/**
 * Restore heredoc placeholders in each supplied fragment. Restoration is not
 * a strict inverse when same-line content followed the delimiter: the body
 * is reinstated right after the operator, before that text. It IS exact when
 * the operator was the last thing on its line (the common case). An empty
 * map returns the input array unchanged.
 */
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

