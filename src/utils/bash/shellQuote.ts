/**
 * Error-tolerant wrappers over the third-party shell tokenizer/quoter, plus
 * two detectors for that library's known divergences from bash.
 *
 * The detectors are security controls, not hygiene: the library silently
 * drops unmatched quotes and mis-handles backslashes inside single quotes,
 * and both failure shapes can hide operators from every token-level check.
 * Callers treat "malformed" / "bug detected" as "do not rebuild from
 * tokens". If the library is ever replaced, these predicates must be
 * re-derived from the new tokenizer's divergences — and until then callers
 * must bail unconditionally (see the slice spec).
 */
import { parse as shellParse, quote as shellQuoteJoin } from 'shell-quote'
import type { ParseEntry } from 'shell-quote'
import { logError } from '../log.js'
import { jsonStringify } from '../slowOperations.js'

export type { ParseEntry } from 'shell-quote'

/** Tokenisation outcome: tokens, or an explicit failure message. */
export type ShellParseResult =
  | { success: true; tokens: ParseEntry[] }
  | { success: false; error: string }

/** Quoting outcome: the quoted string, or an explicit failure message. */
export type ShellQuoteResult =
  | { success: true; quoted: string }
  | { success: false; error: string }

/**
 * Tokenise a command, converting any throw into a failure result. The
 * optional environment (object or lookup function) is forwarded so variable
 * references can be preserved rather than expanded away.
 */
export function tryParseShellCommand(
  cmd: string,
  env?: Record<string, string | undefined> | ((key: string) => string | undefined),
): ShellParseResult {
  try {
    const raw =
      typeof env === 'function'
        ? shellParse(cmd, env)
        : shellParse(cmd, env)
    // The function-overload return admits the lookup's own value type; ours
    // is always a string, so every entry is a ParseEntry.
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

/**
 * Strict quoting: strings pass through, numbers and booleans stringify,
 * null/undefined stringify to their names, and anything structural —
 * objects, arrays, symbols, functions — is rejected with the offending
 * index and type named.
 */
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

/**
 * Lenient quoting: try the strict path, then re-map unsupported values
 * through JSON so they become strings and quote those. The JSON step is
 * never the quoting itself — JSON's double quotes do not stop command
 * substitution — so its output always still passes through the shell
 * quoter, and the only escape hatch is a throw (after logging).
 */
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

/** Count state-changing quotes with bash semantics; used by the parity check. */
function countUnmatchedQuotes(command: string): { doubleQuotes: number; singleQuotes: number } {
  let doubleQuotes = 0
  let singleQuotes = 0
  let state: 'plain' | 'single' | 'double' = 'plain'
  for (let i = 0; i < command.length; i++) {
    const ch = command[i]
    if (state === 'single') {
      // Nothing escapes inside single quotes; the closing quote counts.
      if (ch === "'") {
        singleQuotes++
        state = 'plain'
      }
      continue
    }
    // Outside single quotes a backslash escapes the next character.
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

/** Unbalanced bracket pair inside token text (raw count comparison). */
function hasUnbalancedPair(text: string, open: string, close: string): boolean {
  let opens = 0
  let closes = 0
  for (const ch of text) {
    if (ch === open) opens++
    else if (ch === close) closes++
  }
  return opens !== closes
}

/** Quote occurrences in a token, excluding those a backslash immediately precedes. */
function countUnescapedQuoteChars(text: string, quote: string): number {
  let count = 0
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== quote) continue
    if (i > 0 && text[i - 1] === '\\') continue
    count++
  }
  return count
}

/**
 * Report that the tokenizer probably misread the command. The primary
 * signal is an unmatched quote in the original command: bash-semantics
 * counting (a `"` inside single quotes and a `'` inside double quotes are
 * literal and do not count) catches the case the library silently drops —
 * it removes the unmatched quote and promotes the following separator to an
 * operator, turning a bash syntax error into an executable injection when
 * tokens are rebuilt. Beyond that, EACH string token is examined for an odd
 * count of unescaped double quotes OR an odd count of unescaped single
 * quotes (this catches the class where the TOTAL quote count is even but an
 * individual token is unbalanced — the two-parsers-disagree case), and for
 * an unbalanced bracket pair. Non-string tokens are not examined.
 */
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

/**
 * Detect the library's single-quote-backslash divergence: its chunker
 * treats `\'` as an escape inside single quotes while bash treats a
 * backslash there as literal. Walking with correct bash semantics, the bug
 * bites when a single-quoted run closes with trailing backslashes and
 * either the count is odd (always a divergence), or it is even and another
 * single quote appears later (the chunker consumes the real closing quote,
 * takes the later quote as a false close, and merges tokens bash keeps
 * separate). This is how `'\' payload '\'` hides a payload from every
 * token-level check.
 */
export function hasShellQuoteSingleQuoteBug(command: string): boolean {
  let state: 'plain' | 'single' | 'double' = 'plain'
  for (let i = 0; i < command.length; i++) {
    const ch = command[i]
    if (state === 'single') {
      if (ch === "'") {
        // Count the backslashes immediately before this closing quote.
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
      i++ // outside single quotes a backslash escapes the next character
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
