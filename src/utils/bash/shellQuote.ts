import { parse as shellParse, quote as shellQuoteJoin } from 'shell-quote'
import type { ParseEntry } from 'shell-quote'
import { logError } from '../log.js'
import { jsonStringify } from '../slowOperations.js'

export type { ParseEntry } from 'shell-quote'

export type ShellParseResult =
  | { success: true; tokens: ParseEntry[] }
  | { success: false; error: string }

export type ShellQuoteResult =
  | { success: true; quoted: string }
  | { success: false; error: string }

export function tryParseShellCommand(
  cmd: string,
  env?: Record<string, string | undefined> | ((key: string) => string | undefined),
): ShellParseResult {
  try {
    const raw =
      typeof env === 'function'
        ? shellParse(cmd, env)
        : shellParse(cmd, env)
    const tokens = raw as ParseEntry[]
    return { success: true, tokens }
  } catch (error) {
    if (error instanceof Error) {
      logError(error)
      return { success: false, error: error.message }
    }
    return { success: false, error: 'failed to tokenize shell command' }
  }
}

export function tryQuoteShellArgs(args: unknown[]): ShellQuoteResult {
  const prepared: string[] = []
  for (let i = 0; i < args.length; i++) {
    const value = args[i]
    if (typeof value === 'string') {
      prepared.push(value)
    } else if (typeof value === 'number' || typeof value === 'boolean') {
      prepared.push(String(value))
    } else if (value === null) {
      prepared.push('null')
    } else if (value === undefined) {
      prepared.push('undefined')
    } else {
      return {
        success: false,
        error: `cannot shell-quote argument at index ${i} of type ${typeof value}`,
      }
    }
  }
  try {
    return { success: true, quoted: shellQuoteJoin(prepared) }
  } catch (error) {
    if (error instanceof Error) logError(error)
    return {
      success: false,
      error: error instanceof Error ? error.message : 'failed to quote shell arguments',
    }
  }
}

export function quote(args: ReadonlyArray<unknown>): string {
  const strict = tryQuoteShellArgs([...args])
  if (strict.success) {
    return strict.quoted
  }
  const remapped = args.map(value => {
    if (typeof value === 'string') return value
    if (typeof value === 'number' || typeof value === 'boolean') return String(value)
    if (value === null) return 'null'
    if (value === undefined) return 'undefined'
    return jsonStringify(value)
  })
  try {
    return shellQuoteJoin(remapped)
  } catch (error) {
    if (error instanceof Error) logError(error)
    throw error
  }
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
  let state: 'plain' | 'single' | 'double' = 'plain'
  for (let i = 0; i < command.length; i++) {
    const ch = command[i]
    if (state === 'single') {
      if (ch === "'") {
        let backslashes = 0
        let j = i - 1
        while (j >= 0 && command[j] === '\\') {
          backslashes++
          j--
        }
        if (backslashes > 0) {
          if (backslashes % 2 === 1) return true
          if (command.indexOf("'", i + 1) !== -1) return true
        }
        state = 'plain'
      }
      continue
    }
    if (ch === '\\') {
      i++
      continue
    }
    if (ch === '"') {
      state = state === 'double' ? 'plain' : 'double'
      continue
    }
    if (ch === "'" && state === 'plain') {
      state = 'single'
      continue
    }
  }
  return false
}
