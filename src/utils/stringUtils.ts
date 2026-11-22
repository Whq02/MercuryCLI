import stripAnsi from 'strip-ansi'
import { notBuilt, unbuilt } from '../pi/holes.js'


export function escapeRegExp(str: string): string {
  return notBuilt('src/utils/stringUtils.ts:4')
}

export function capitalize(str: string): string {
  return notBuilt('src/utils/stringUtils.ts:8')
}

export function plural(n: number, word: string, pluralWord?: string): string {
  return notBuilt('src/utils/stringUtils.ts:13')
}

export function firstLineOf(s: string): string {
  return notBuilt('src/utils/stringUtils.ts:21')
}

export function collapseWhitespace(text: string): string {
  return notBuilt('src/utils/stringUtils.ts:26')
}

export function clipWithEllipsis(text: string, max: number): string {
  return notBuilt('src/utils/stringUtils.ts:30')
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

export function countCharInString(haystack: IndexSearchable, char: string, start?: number): number {
  return notBuilt('src/utils/stringUtils.ts:50')
}

export function normalizeFullWidthDigits(input: string): string {
  return notBuilt('src/utils/stringUtils.ts:62')
}

export function normalizeFullWidthSpace(input: string): string {
  return notBuilt('src/utils/stringUtils.ts:68')
}

export function safeJoinLines(lines: string[], delimiter?: string, maxSize?: number): string {
  return notBuilt('src/utils/stringUtils.ts:74')
}

export class EndTruncatingAccumulator {
  private content: string = unbuilt('src/utils/stringUtils.ts:92')
  private hasTruncated: boolean = unbuilt('src/utils/stringUtils.ts:93')
  private totalReceived: number = unbuilt('src/utils/stringUtils.ts:94')

  constructor(private readonly maxSize?: number) {
    notBuilt('src/utils/stringUtils.ts:96')
  }

  append(data: string | Buffer): void {
    return notBuilt('src/utils/stringUtils.ts:98')
  }

  toString(): string {
    return notBuilt('src/utils/stringUtils.ts:111')
  }

  clear(): void {
    return notBuilt('src/utils/stringUtils.ts:117')
  }

  get length(): number {
    return notBuilt('src/utils/stringUtils.ts:123')
  }

  get truncated(): boolean {
    return notBuilt('src/utils/stringUtils.ts:127')
  }

  get totalBytes(): number {
    return notBuilt('src/utils/stringUtils.ts:131')
  }
}

export function truncateToLines(text: string, maxLines: number): string {
  return notBuilt('src/utils/stringUtils.ts:136')
}

export function stripTerminalControls(text: string): string {
  return stripAnsi(text)
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000B-\u000C\u000E-\u001F\u007F\u0080-\u009F]/g, '')
}
