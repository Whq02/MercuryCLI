import stripAnsi from 'strip-ansi'

/**
 * Small string helpers, a bounded output accumulator, and the
 * terminal-control sanitizer that owns the paste-safety strip.
 */

/** Escape a string for use as a literal regular-expression pattern. `-` and `/` are deliberately not escaped. */
export function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Upper-cases the first character only; the remainder is untouched. */
export function capitalize(str: string): string {
  if (str === '') return str
  return str.charAt(0).toUpperCase() + str.slice(1)
}

/** The singular word for a count of exactly one, otherwise the plural (default: word + `s`). */
export function plural(n: number, word: string, pluralWord: string = `${word}s`): string {
  return n === 1 ? word : pluralWord
}

/** The substring before the first newline, without allocating a split array. */
export function firstLineOf(s: string): string {
  const newlineIndex = s.indexOf('\n')
  return newlineIndex === -1 ? s : s.slice(0, newlineIndex)
}

type IndexSearchable = {
  indexOf(needle: string, start?: number): number
}

/** Occurrences of a single-character needle, advancing by index jumps. Structurally typed so byte buffers qualify too. */
export function countCharInString(haystack: IndexSearchable, char: string, start: number = 0): number {
  let count = 0
  let index = haystack.indexOf(char, start)
  while (index !== -1) {
    count++
    index = haystack.indexOf(char, index + 1)
  }
  return count
}

// The full-width digit block sits at a fixed offset from the ASCII digits.
const FULL_WIDTH_DIGIT_OFFSET = 0xfee0

/** Maps full-width digits (CJK input-method input) to ASCII digits. */
export function normalizeFullWidthDigits(input: string): string {
  return input.replace(/[０-９]/g, digit =>
    String.fromCharCode(digit.charCodeAt(0) - FULL_WIDTH_DIGIT_OFFSET),
  )
}

/** Maps the ideographic space to an ASCII space. */
export function normalizeFullWidthSpace(input: string): string {
  return input.replace(/　/g, ' ')
}

const TRUNCATION_MARKER = '…[content truncated]'

/**
 * Joins lines with a delimiter up to a maximum size. The first line that
 * does not fit is cut to the remaining room (or dropped when there is
 * none), a truncation marker is appended, and no later line is considered.
 */
export function safeJoinLines(lines: string[], delimiter: string = ',', maxSize: number = 2 ** 25): string {
  let result = ''
  for (const line of lines) {
    const joiner = result === '' ? '' : delimiter
    if (result.length + joiner.length + line.length <= maxSize) {
      result += joiner + line
      continue
    }
    const room = maxSize - result.length - delimiter.length - TRUNCATION_MARKER.length
    if (room > 0) {
      return result + delimiter + line.slice(0, room) + TRUNCATION_MARKER
    }
    return result + TRUNCATION_MARKER
  }
  return result
}

/**
 * Accumulates appended output up to a maximum size, keeping the head. The
 * total-received counter advances on every append — including appends made
 * after capacity — so the truncation note can say how much was dropped.
 */
export class EndTruncatingAccumulator {
  private content = ''
  private hasTruncated = false
  private totalReceived = 0

  constructor(private readonly maxSize: number = 2 ** 25) {}

  append(data: string | Buffer): void {
    const text = typeof data === 'string' ? data : data.toString()
    this.totalReceived += text.length
    if (this.hasTruncated) return
    if (this.content.length + text.length <= this.maxSize) {
      this.content += text
      return
    }
    const room = this.maxSize - this.content.length
    this.content += text.slice(0, room)
    this.hasTruncated = true
  }

  toString(): string {
    if (!this.hasTruncated) return this.content
    const removedKb = Math.round((this.totalReceived - this.maxSize) / 1024)
    return `${this.content}\n[${removedKb}KB truncated from the end of the output]`
  }

  clear(): void {
    this.content = ''
    this.hasTruncated = false
    this.totalReceived = 0
  }

  get length(): number {
    return this.content.length
  }

  get truncated(): boolean {
    return this.hasTruncated
  }

  get totalBytes(): number {
    return this.totalReceived
  }
}

/** Keeps at most N lines; when more exist, the ellipsis follows the last kept line directly. */
export function truncateToLines(text: string, maxLines: number): string {
  const lines = text.split('\n')
  if (lines.length <= maxLines) return text
  return `${lines.slice(0, maxLines).join('\n')}…`
}

/**
 * Makes arbitrary text inert for terminal rendering (the paste-safety
 * strip owner). Three ordered steps: strip well-formed ANSI sequences,
 * normalise carriage returns to newlines, then delete every remaining
 * control character — a stray bell byte can close an OSC sequence early, a
 * backspace repositions the cursor, and the 8-bit CSI introducer is still
 * honoured by terminals after the 7-bit forms are absent. Tab and newline
 * survive by construction.
 */
export function stripTerminalControls(text: string): string {
  return stripAnsi(text)
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000B-\u000C\u000E-\u001F\u007F\u0080-\u009F]/g, '')
}
