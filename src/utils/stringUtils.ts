import stripAnsi from 'strip-ansi'
export { escapeRegExp } from 'lodash-es'

const MAX_CONTENT_SIZE = 2 ** 25
const TRUNCATION_MARK = '…[content truncated]'

export function capitalize(str: string): string {
  return str.slice(0, 1).toUpperCase() + str.slice(1)
}

export function plural(n: number, word: string, pluralWord?: string): string {
  if (n === 1) return word
  return pluralWord ?? (/[^aeiou]y$/i.test(word) ? `${word.slice(0, -1)}ies` : `${word}s`)
}

export function firstLineOf(s: string): string {
  const end = s.indexOf('\n')
  return end < 0 ? s : s.slice(0, end)
}

export function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

export function clipWithEllipsis(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, max - 1) + '…'
}

export function collapseAndClip(text: string, max: number): string {
  return clipWithEllipsis(collapseWhitespace(text), max)
}

export function collapseAndSlice(text: string, max: number): string {
  return collapseWhitespace(text).slice(0, max)
}

export function wordCount(text: string): number {
  return text.split(/\s+/).filter(Boolean).length
}

type IndexSearchable = {
  indexOf(needle: string, start?: number): number
}

export function countCharInString(haystack: IndexSearchable, char: string, start = 0): number {
  let count = 0
  let index = haystack.indexOf(char, start)
  while (index >= 0 && index >= start) {
    count++
    start = index + 1
    index = haystack.indexOf(char, start)
  }
  return count
}

export function normalizeFullWidthDigits(input: string): string {
  return input.replace(/[０-９]/g, digit => String.fromCharCode(digit.charCodeAt(0) - 0xfee0))
}

export function normalizeFullWidthSpace(input: string): string {
  return input.replaceAll('\u3000', ' ')
}

export function safeJoinLines(lines: string[], delimiter = ',', maxSize = MAX_CONTENT_SIZE): string {
  let content = ''
  for (const line of lines) {
    const joiner = content ? delimiter : ''
    const length = content.length + joiner.length
    if (length + line.length > maxSize) {
      const room = maxSize - length - TRUNCATION_MARK.length
      return content + (room > 0 ? joiner + line.slice(0, room) : '') + TRUNCATION_MARK
    }
    content += joiner + line
  }
  return content
}

export class EndTruncatingAccumulator {
  private content = ''
  private hasTruncated = false
  private totalReceived = 0

  constructor(private readonly maxSize = MAX_CONTENT_SIZE) {}

  append(data: string | Buffer): void {
    const text = data.toString()
    this.totalReceived += text.length
    if (this.hasTruncated) return
    const room = this.maxSize - this.content.length
    if (text.length <= room) this.content += text
    else {
      this.content += text.slice(0, Math.max(0, room))
      this.hasTruncated = true
    }
  }

  toString(): string {
    if (!this.hasTruncated) return this.content
    const kb = Math.round((this.totalReceived - this.maxSize) / 1024)
    return `${this.content}\n[${kb}KB truncated from the end of the output]`
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
  return lines.length <= maxLines ? text : lines.slice(0, maxLines).join('\n') + '…'
}

export function stripTerminalControls(text: string): string {
  return stripAnsi(text)
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000B-\u000C\u000E-\u001F\u007F\u0080-\u009F]/g, '')
}
