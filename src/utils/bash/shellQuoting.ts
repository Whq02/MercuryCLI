/**
 * Quotes a shell command for eval-style re-execution, decides stdin-redirect
 * insertion, and rewrites Windows `>nul` redirects.
 *
 * The harness always runs a POSIX shell (including on Windows), so a
 * CMD-style `>nul` the model emits would otherwise create a regular file
 * named after a reserved device.
 */
import { quote } from './shellQuote.js'

/** Bit-shift forms that must NOT be read as heredocs. */
const DIGIT_SHIFT_RE = /\d\s*<<\s*\d/
const ARITH_TEST_SHIFT_RE = /\[\[\s*\d+\s*<<\s*\d+\s*\]\]/

/** A heredoc operator with a delimiter word (bare, quoted, or backslash-escaped). */
const HEREDOC_RE = /<<-?\s*(?:'[A-Za-z0-9_]+'|"[A-Za-z0-9_]+"|\\?[A-Za-z0-9_]+)/

/**
 * Whether a command contains a heredoc. Bit-shift forms are excluded first
 * and any match on one makes the whole answer false. Module-private: the
 * two decisions below are its only consumers.
 */
function containsHeredoc(command: string): boolean {
  if (DIGIT_SHIFT_RE.test(command)) return false
  if (ARITH_TEST_SHIFT_RE.test(command)) return false
  // A `<<` anywhere inside an arithmetic expansion $(( … )) is a shift.
  if (hasShiftInsideArithmetic(command)) return false
  return HEREDOC_RE.test(command)
}

/** Detect a `<<` that falls inside an arithmetic expansion. */
function hasShiftInsideArithmetic(command: string): boolean {
  let index = command.indexOf('$((')
  while (index !== -1) {
    const close = command.indexOf('))', index + 3)
    const end = close === -1 ? command.length : close
    if (command.slice(index + 3, end).includes('<<')) return true
    index = command.indexOf('$((', end + 1)
  }
  return false
}

/**
 * Whether a single- or double-quoted region contains a literal newline. The
 * region may contain backslash-escaped characters, including escaped quotes.
 */
export function hasMultilineQuotedString(command: string): boolean {
  let state: 'plain' | 'single' | 'double' = 'plain'
  let regionHasNewline = false
  for (let i = 0; i < command.length; i++) {
    const ch = command[i]
    if (state === 'plain') {
      if (ch === "'") {
        state = 'single'
        regionHasNewline = false
      } else if (ch === '"') {
        state = 'double'
        regionHasNewline = false
      }
      continue
    }
    if (ch === '\\' && i + 1 < command.length) {
      i++ // an escaped character (including a quote) stays inside the region
      continue
    }
    if (ch === '\n') {
      regionHasNewline = true
      continue
    }
    if ((state === 'single' && ch === "'") || (state === 'double' && ch === '"')) {
      if (regionHasNewline) return true
      state = 'plain'
    }
  }
  return false
}

/** Single-quote via close/quoted-quote/reopen (never the library, which escapes `!`). */
function posixSingleQuote(text: string): string {
  return `'${text.split("'").join("'\\''")}'`
}

/**
 * Detect an existing stdin redirect: a `<` preceded by string start,
 * whitespace, or `;`/`&`/`|`, not followed by `<` or `(`, then optional
 * whitespace and at least one non-whitespace character.
 */
export function hasStdinRedirect(command: string): boolean {
  return /(?:^|[\s;&|])<(?![<(])\s*\S/.test(command)
}

/** Whether a stdin redirect should be added: not for heredocs, not if one exists. */
export function shouldAddStdinRedirect(command: string): boolean {
  if (containsHeredoc(command)) return false
  if (hasStdinRedirect(command)) return false
  return true
}

/**
 * Quote a command for re-execution. Heredocs and multiline quoted strings are
 * hand-quoted (the library adds a stray backslash before `!`); everything
 * else goes through the shell-quoting library, with the redirect as separate
 * tokens when requested.
 */
export function quoteShellCommand(command: string, addStdinRedirect = true): string {
  const heredoc = containsHeredoc(command)
  if (heredoc || hasMultilineQuotedString(command)) {
    const quoted = posixSingleQuote(command)
    // Heredocs supply their own input; multiline strings get the redirect
    // (outside the quotes) only when requested.
    if (!heredoc && addStdinRedirect) {
      return `${quoted} < /dev/null`
    }
    return quoted
  }
  if (addStdinRedirect) {
    return quote([command, '<', '/dev/null'])
  }
  return quote([command])
}

/**
 * Replace every `>nul` redirect target with `/dev/null`, preserving the
 * operator text verbatim. Matches an optional leading digit, optional `&`,
 * one or more `>`, optional whitespace, then a case-insensitive `nul`
 * followed by whitespace, end, or one of `|`, `&`, `;`, `)`, newline.
 */
export function rewriteWindowsNullRedirect(command: string): string {
  return command.replace(
    /(\d?&?>+\s*)nul(?=\s|$|[|&;)\n])/gi,
    (_match, operator: string) => `${operator}/dev/null`,
  )
}
