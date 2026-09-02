import stripAnsi from 'strip-ansi'


export function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export function capitalize(str: string): string {
  if (str === '') return str
  return str.charAt(0).toUpperCase() + str.slice(1)
}

export function plural(n: number, word: string, pluralWord: string = `${word}s`): string {
  return n === 1 ? word : pluralWord
}

export function firstLineOf(s: string): string {
  const newlineIndex = s.indexOf('\n')
  return newlineIndex === -1 ? s : s.slice(0, newlineIndex)
}

type IndexSearchable = {
  indexOf(needle: string, start?: number): number
}

export function countCharInString(haystack: IndexSearchable, char: string, start: number = 0): number {
  let count = 0
  let index = haystack.indexOf(char, start)
  while (index !== -1) {
    count++
    index = haystack.indexOf(char, index + 1)
  }
  return count
}

const FULL_WIDTH_DIGIT_OFFSET = 0xfee0

export function normalizeFullWidthDigits(input: string): string {
  return input.replace(/[０-９]/g, digit =>
    String.fromCharCode(digit.charCodeAt(0) - FULL_WIDTH_DIGIT_OFFSET),
  )
}

export function normalizeFullWidthSpace(input: string): string {
  return input.replace(/　/g, ' ')
}

const TRUNCATION_MARKER = '…[content truncated]'

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

export function truncateToLines(text: string, maxLines: number): string {
  const lines = text.split('\n')
  if (lines.length <= maxLines) return text
  return `${lines.slice(0, maxLines).join('\n')}…`
}

export function stripTerminalControls(text: string): string {
  return stripAnsi(text)
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000B-\u000C\u000E-\u001F\u007F\u0080-\u009F]/g, '')
}
