import { parse as shellParse, quote as shellQuoteJoin } from 'shell-quote'
import type { ParseEntry } from 'shell-quote'
import { logError } from '../../logs/errorLog.js'
import { jsonStringify } from '../../logs/slowOperations.js'

type ShellParseResult =
  | { success: true; tokens: ParseEntry[] }
  | { success: false; error: string }

type ShellQuoteResult =
  | { success: true; quoted: string }
  | { success: false; error: string }

export function tryParseShellCommand(
  cmd: string,
  env?: Record<string, string | undefined> | ((key: string) => string | undefined),
): ShellParseResult {
  try {
    const tokens: ParseEntry[] =
      typeof env === 'function' ? shellParse<string>(cmd, env) : shellParse(cmd, env)
    return { success: true, tokens }
  } catch (error) {
    if (error instanceof Error) {
      logError(error)
      return { success: false, error: error.message }
    }
    return { success: false, error: 'failed to tokenize shell command' }
  }
}

function tryQuoteShellArgs(args: ReadonlyArray<unknown>): ShellQuoteResult {
  const stringArgs: string[] = []
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (typeof arg === 'string') {
      stringArgs.push(arg)
    } else if (typeof arg === 'number' || typeof arg === 'boolean') {
      stringArgs.push(String(arg))
    } else if (arg === null) {
      stringArgs.push('null')
    } else if (arg === undefined) {
      stringArgs.push('undefined')
    } else {
      return {
        success: false,
        error: `cannot shell-quote argument at index ${i} of type ${typeof arg}`,
      }
    }
  }
  try {
    return { success: true, quoted: shellQuoteJoin(stringArgs) }
  } catch (error) {
    if (error instanceof Error) {
      logError(error)
      return { success: false, error: error.message }
    }
    return { success: false, error: 'failed to quote shell arguments' }
  }
}

export function quote(args: ReadonlyArray<unknown>): string {
  const result = tryQuoteShellArgs(args)
  if (result.success) return result.quoted
  const fallbackArgs = args.map(arg => {
    if (typeof arg === 'string') return arg
    if (typeof arg === 'number' || typeof arg === 'boolean') return String(arg)
    if (arg === null) return 'null'
    if (arg === undefined) return 'undefined'
    return jsonStringify(arg)
  })
  try {
    return shellQuoteJoin(fallbackArgs)
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
        for (let j = i - 1; j >= 0 && command[j] === '\\'; j--) {
          backslashes++
        }
        if (backslashes % 2 === 1 || (backslashes > 0 && command.indexOf("'", i + 1) !== -1)) {
          return true
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
    }
  }
  return false
}
