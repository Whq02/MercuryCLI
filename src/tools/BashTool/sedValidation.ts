/**
 * `sed` policy. `sed` is both the most common read helper and a full
 * write/execute engine (`w`, `W`, `e`, `E`, `-i`). This module splits the
 * provably-safe subset — print-only programs and plain slash-delimited
 * substitutions — from everything else, which needs explicit approval.
 *
 * Fail-closed: a tokenisation failure, an unrecognised program shape, or any
 * expression the denylist flags means "not allowed".
 */
import type { ToolPermissionContext } from '../../Tool.js'
import type { PermissionResult } from '../../utils/permissions/PermissionResult.js'
import {
  splitCommand_DEPRECATED,
  tryParseShellCommand,
} from '../../utils/permissions/decision/commandAnalysis.js'

/** Tokenise the argument portion after `sed `; string + glob tokens as strings, or throw. */
function tokeniseSedArgs(command: string): { tokens: Array<string | null>; ok: boolean } {
  const parse = tryParseShellCommand(command.replace(/^sed\s+/, ''))
  if (!parse.success) return { tokens: [], ok: false }
  // Represent a glob as a marker `null`; strings as themselves; operators as null too.
  const tokens = parse.tokens.map(token => (typeof token === 'string' ? token : GLOB_OR_OP))
  return { tokens, ok: true }
}

const GLOB_OR_OP: null = null

/** Does the sed command carry file operands? Fail-closed (true) on any parse trouble. */
export function hasFileArgs(command: string): boolean {
  if (!/^sed\s/.test(command)) return false
  let parseOk = true
  let glob = false
  const parse = tryParseShellCommand(command.replace(/^sed\s+/, ''))
  if (!parse.success) return true // fail closed
  const tokens = parse.tokens.map(token => {
    if (typeof token === 'string') return token
    if (isGlobToken(token)) glob = true
    return null
  })
  if (!parseOk) return true
  if (glob) return true

  let expressionFlagSeen = false
  let nonFlagCount = 0
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]
    if (token === null) continue
    if (token === '-e' || token === '--expression') {
      if (tokens[i + 1] !== undefined) {
        i++
        expressionFlagSeen = true
      }
      continue
    }
    if (/^(?:--expression=|-e=)/.test(token)) {
      expressionFlagSeen = true
      continue
    }
    if (token.startsWith('-')) continue
    // A non-flag token.
    if (expressionFlagSeen) return true // already a file operand
    nonFlagCount++
    if (nonFlagCount >= 2) return true // program is #1; #2+ are files
  }
  return false
}

/** Extract sed expressions; THROWS on dangerous combined-flag clusters or a tokenise failure. */
export function extractSedExpressions(command: string): string[] {
  if (!/^sed\s/.test(command)) return []
  const argText = command.replace(/^sed\s+/, '')
  // Before tokenising, reject dangerous combined-flag clusters.
  if (/-e\s*[wWe]/.test(argText) || /-w\s*[eE]/.test(argText)) {
    throw new Error('sed: dangerous combined flags')
  }
  const parse = tryParseShellCommand(argText)
  if (!parse.success) throw new Error('sed: unparseable')
  const tokens = parse.tokens.map(token => (typeof token === 'string' ? token : null))

  const expressions: string[] = []
  let expressionFlagSeen = false
  let standaloneCaptured = false
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]
    if (token === null) continue
    if (token === '-e' || token === '--expression') {
      const next = tokens[i + 1]
      if (next !== undefined && next !== null) {
        expressions.push(next)
        i++
        expressionFlagSeen = true
      } else if (next === null) {
        expressionFlagSeen = true // a non-string follower yields nothing
        i++
      }
      // a trailing -e with nothing after sets no marker
      continue
    }
    if (/^(?:--expression=|-e=)/.test(token)) {
      expressions.push(token.replace(/^(?:--expression=|-e=)/, ''))
      expressionFlagSeen = true
      continue
    }
    if (token.startsWith('-')) continue
    if (!expressionFlagSeen && !standaloneCaptured) {
      expressions.push(token)
      standaloneCaptured = true
      break // the rest are filenames
    }
    break
  }
  return expressions
}

/** A single `;`-piece that is exactly an optional address followed by `p`. */
export function isPrintCommand(cmd: string): boolean {
  return /^\s*(?:\d+(?:,\d+)?)?p\s*$/.test(cmd)
}

/** Pattern 1 (print-only) over pre-extracted expressions. */
export function isLinePrintingCommand(command: string, expressions: string[]): boolean {
  if (!/^sed\s/.test(command)) return false
  const parse = tryParseShellCommand(command.replace(/^sed\s+/, ''))
  if (!parse.success) return false
  const printFlags = new Set(['-n', '--quiet', '--silent', '-E', '--regexp-extended', '-r', '-z', '--zero-terminated', '--posix'])
  const shortFlagLetters = new Set(['n', 'E', 'r', 'z'])
  let quietPresent = false
  for (const token of parse.tokens) {
    if (typeof token !== 'string') continue
    if (!token.startsWith('-') || token === '--') continue
    if (printFlags.has(token)) {
      if (token === '-n' || token === '--quiet' || token === '--silent') quietPresent = true
      continue
    }
    // A short cluster longer than two chars: validate char by char.
    if (/^-[a-zA-Z]{2,}$/.test(token)) {
      const letters = token.slice(1).split('')
      if (!letters.every(l => shortFlagLetters.has(l))) return false
      if (letters.includes('n')) quietPresent = true
      continue
    }
    return false
  }
  if (!quietPresent) return false
  if (expressions.length === 0) return false
  for (const expression of expressions) {
    const pieces = expression.split(';')
    for (const piece of pieces) {
      if (!isPrintCommand(piece)) return false // also fails on an empty piece
    }
  }
  return true
}

/** Pattern 2 (substitution) — stdout-only or file-writing variant. */
function isSubstitutionCommand(command: string, expressions: string[], allowFileWrites: boolean): boolean {
  if (!/^sed\s/.test(command)) return false
  if (!allowFileWrites && hasFileArgs(command)) return false
  const parse = tryParseShellCommand(command.replace(/^sed\s+/, ''))
  if (!parse.success) return false
  const flags = new Set(['-E', '--regexp-extended', '-r', '--posix'])
  const writeFlags = new Set(['-i', '--in-place'])
  const shortFlagLetters = new Set(['E', 'r', ...(allowFileWrites ? ['i'] : [])])
  for (const token of parse.tokens) {
    if (typeof token !== 'string') continue
    if (!token.startsWith('-') || token === '--') continue
    if (flags.has(token)) continue
    if (allowFileWrites && writeFlags.has(token)) continue
    if (/^-[a-zA-Z]{2,}$/.test(token) && token.slice(1).split('').every(l => shortFlagLetters.has(l))) continue
    return false
  }
  if (expressions.length !== 1) return false
  const expression = (expressions[0] as string).trim()
  if (!expression.startsWith('s/')) return false
  // Exactly two unescaped `/` in the remainder AFTER `s/`, skipping escapes.
  let slashes = 0
  for (let i = 2; i < expression.length; i++) {
    if (expression[i] === '\\') {
      i++
      continue
    }
    if (expression[i] === '/') slashes++
  }
  if (slashes !== 2) return false
  // Trailing flags: only g p i I m M and at most one digit 1-9.
  const lastSlash = expression.lastIndexOf('/')
  const trailing = expression.slice(lastSlash + 1)
  let digits = 0
  for (const ch of trailing) {
    if ('gpiImM'.includes(ch)) continue
    if (/[1-9]/.test(ch)) {
      digits++
      if (digits > 1) return false
      continue
    }
    return false
  }
  return true
}

/** The main allowlist decision. Pure; swallows extraction errors and returns false. */
export function sedCommandIsAllowedByAllowlist(command: string, options?: { allowFileWrites?: boolean }): boolean {
  const allowFileWrites = options?.allowFileWrites === true
  let expressions: string[]
  try {
    expressions = extractSedExpressions(command)
  } catch {
    return false
  }

  let matched: 1 | 2 | null = null
  if (!allowFileWrites) {
    if (isLinePrintingCommand(command, expressions)) matched = 1
    else if (isSubstitutionCommand(command, expressions, false)) matched = 2
  } else {
    if (isSubstitutionCommand(command, expressions, true)) matched = 2
  }
  if (matched === null) return false
  // A substitution containing a `;` would smuggle a second sed command.
  if (matched === 2 && expressions.some(e => e.includes(';'))) return false
  // The denylist over every expression.
  if (expressions.some(isDangerousExpression)) return false
  return true
}

// ── the expression denylist (each hit = dangerous) ─────────────────────

function isDangerousExpression(expression: string): boolean {
  // 1. Any character outside U+0001–U+007F.
  for (const ch of expression) {
    const code = ch.codePointAt(0) ?? 0
    if (code < 0x0001 || code > 0x007f) return true
  }
  // 2. Contains `{` or `}`.
  if (expression.includes('{') || expression.includes('}')) return true
  // 3. Contains a newline.
  if (expression.includes('\n')) return true
  // 4. The first `#` not immediately preceded by `s`.
  const firstHash = expression.indexOf('#')
  if (firstHash !== -1 && expression[firstHash - 1] !== 's') return true
  // 5. Begins with `!`, or `!` after `/`, a digit, or `$`.
  if (expression.startsWith('!')) return true
  if (/[/\d$]!/.test(expression)) return true
  // 6. GNU step-address: (digit|,|$) optws ~ optws digit.
  if (/[\d,$]\s*~\s*\d/.test(expression)) return true
  // 7. Begins with `,`.
  if (expression.startsWith(',')) return true
  // 8. `,` optws `+` or `-`.
  if (/,\s*[+-]/.test(expression)) return true
  // 9. `s\` (backslash delimiter), or `\` followed by | # % @.
  if (/^s\\/.test(expression)) return true
  if (/\\[|#%@]/.test(expression)) return true
  // 10. An escaped slash anywhere, followed later by w or W.
  if (/\\\/[\s\S]*[wW]/.test(expression)) return true
  // 11. `/` non-slash* whitespace (w|W|e|E).
  if (/\/[^/]*\s+[wWeE]/.test(expression)) return true
  // 12. Begins with `s/` but not the exact three-field slash form.
  if (expression.startsWith('s/') && !/^s\/[^/]*\/[^/]*\/[^/]*$/.test(expression)) return true
  // 13. Begins with `s` + any char and ends with w/W/e/E, unless a well-formed
  //     substitution whose trailing flags carry none of w W e E.
  if (/^s.[\s\S]*[wWeE]$/.test(expression) && !isWellFormedSubstitutionWithoutWriteFlags(expression)) return true
  // 14. Write-command forms (w/W + ws + operand) in the seven address positions.
  if (WRITE_COMMAND_RE.test(expression)) return true
  // 15. Execute-command forms (bare e) in the seven address positions.
  if (EXECUTE_COMMAND_RE.test(expression)) return true
  // 16. A substitution whose trailing flags contain w W e E (any delimiter, not anchored).
  if (SUBSTITUTION_WRITE_FLAG_RE.test(expression)) return true
  // 17. A `y` transliterate combined with any w/W/e/E anywhere.
  if (/y[^\\\n]/.test(expression) && /[wWeE]/.test(expression)) return true
  return false
}

/** A well-formed substitution whose trailing flags carry none of w W e E. */
function isWellFormedSubstitutionWithoutWriteFlags(expression: string): boolean {
  if (expression.length < 4 || expression[0] !== 's') return false
  const delimiter = expression[1] as string
  if (delimiter === '\\' || delimiter === '\n') return false
  // s<delim>pat<delim>rep<delim>flags — flags carry none of w W e E.
  let count = 0
  let flagsStart = -1
  for (let i = 1; i < expression.length; i++) {
    if (expression[i] === '\\') {
      i++
      continue
    }
    if (expression[i] === delimiter) {
      count++
      if (count === 3) {
        flagsStart = i + 1
        break
      }
    }
  }
  if (flagsStart === -1) return false
  return !/[wWeE]/.test(expression.slice(flagsStart))
}

// Address prefixes (a line number, `$`, a `/pat/` with optional modifiers, ranges).
const ADDR = String.raw`(?:\d+|\$|\/[^/\n]*\/[IMim]*|\d+,\d+|\d+,\$|\/[^/\n]*\/,\/[^/\n]*\/)`
// 14: w/W + whitespace + operand in one of the seven positions (start included).
const WRITE_COMMAND_RE = new RegExp(String.raw`(?:^|${ADDR})\s*[wW]\s+\S`)
// 15: bare e in the seven positions; first arm is "starts with e".
const EXECUTE_COMMAND_RE = new RegExp(String.raw`^e|${ADDR}\s*e(?![a-zA-Z])`)
// 16: a substitution with a w/W/e/E trailing flag, any delimiter, unanchored.
const SUBSTITUTION_WRITE_FLAG_RE = /s([^\\\n])(?:\\.|(?!\1)[^\\\n])*\1(?:\\.|(?!\1)[^\\\n])*\1[gpiImM0-9]*[wWeE]/

// ── the cross-cutting sed constraint check ─────────────────────────────

/** Ask when any sed subcommand is not allowed by policy; else passthrough. Propagates a split failure. */
export function checkSedConstraints(input: { command: string }, context: ToolPermissionContext): PermissionResult {
  const allowFileWrites = context.mode === 'implement'
  const subcommands = splitCommand_DEPRECATED(input.command)
  for (const raw of subcommands) {
    const subcommand = raw.trim()
    if (subcommand.split(/\s+/)[0] !== 'sed') continue
    if (!sedCommandIsAllowedByAllowlist(subcommand, { allowFileWrites })) {
      return {
        behavior: 'ask',
        message: 'This sed command needs approval because it contains potentially dangerous operations.',
        decisionReason: {
          type: 'other',
          reason: 'The command contains sed operations that require explicit approval, such as write or execute commands.',
        },
      }
    }
  }
  return { behavior: 'passthrough', message: 'No sed constraint applies.' }
}

/** Whether a shell-quote token is a glob. */
function isGlobToken(token: unknown): boolean {
  return typeof token === 'object' && token !== null && (token as { op?: string }).op === 'glob'
}
