import { parse as shellParse, quote as shellQuoteJoin } from 'shell-quote'
import type { ParseEntry } from 'shell-quote'
import { logError } from '../log.js'
import { jsonStringify } from '../slowOperations.js'
import { notBuilt, type Unbuilt } from '../../pi/holes.js'

type ShellParseResult = Unbuilt

export function tryParseShellCommand(
  cmd: string,
  env?: Record<string, string | undefined> | ((key: string) => string | undefined),
): ShellParseResult {
  return notBuilt('src/utils/bash/shellQuote.ts:14')
}

export function quote(args: ReadonlyArray<unknown>): string {
  return notBuilt('src/utils/bash/shellQuote.ts:64')
}

function countUnmatchedQuotes(command: string): { doubleQuotes: number; singleQuotes: number } {
  let doubleQuotes = 0
  let singleQuotes = 0
  let state: 'plain' | 'single' | 'double' = 'plain'
  for (let i = 0; i < command.length; i++) {
    const ch = command[i]
    if (state === 'single') {
      if (ch === "'") {
        singleQuotes++
        state = 'plain'
      }
      continue
    }
    if (ch === '\\') {
      i++
      continue
    }
    if (ch === '"') {
      doubleQuotes++
      state = state === 'double' ? 'plain' : 'double'
      continue
    }
    if (ch === "'" && state === 'plain') {
      singleQuotes++
      state = 'single'
      continue
    }
  }
  return { doubleQuotes, singleQuotes }
}

function hasUnbalancedPair(text: string, open: string, close: string): boolean {
  let opens = 0
  let closes = 0
  for (const ch of text) {
    if (ch === open) opens++
    else if (ch === close) closes++
  }
  return opens !== closes
}

function countUnescapedQuoteChars(text: string, quote: string): number {
  let count = 0
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== quote) continue
    if (i > 0 && text[i - 1] === '\\') continue
    count++
  }
  return count
}

export function hasMalformedTokens(command: string, parsed: ParseEntry[]): boolean {
  const counts = countUnmatchedQuotes(command)
  if (counts.doubleQuotes % 2 === 1 || counts.singleQuotes % 2 === 1) {
    return true
  }
  for (const token of parsed) {
    if (typeof token !== 'string') continue
    if (countUnescapedQuoteChars(token, '"') % 2 === 1 || countUnescapedQuoteChars(token, "'") % 2 === 1) {
      return true
    }
    if (
      hasUnbalancedPair(token, '{', '}') ||
      hasUnbalancedPair(token, '(', ')') ||
      hasUnbalancedPair(token, '[', ']')
    ) {
      return true
    }
  }
  return false
}

export function hasShellQuoteSingleQuoteBug(command: string): boolean {
  return notBuilt('src/utils/bash/shellQuote.ts:156')
}
