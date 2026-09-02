/**
 * Parses a simple in-place `sed` substitution into structured edit info and
 * applies it to file content, so the permission dialog can show the operator a
 * real file diff instead of an opaque shell command.
 *
 * This is a PRESENTATION parser: returning "not parseable" costs a nicer
 * dialog, never safety — the sed security policy (sedValidation.ts) is the
 * control. Anything it cannot render as a clean single-file substitution falls
 * back to the plain command dialog.
 */
import { tryParseShellCommand } from '../../utils/permissions/decision/commandAnalysis.js'

/** A parsed in-place sed substitution. */
export type SedEditInfo = {
  filePath: string
  pattern: string
  replacement: string
  flags: string
  extendedRegex: boolean
}

/** Flags the substitution program may legitimately carry. Contract data. */
const ALLOWED_SED_FLAGS = /^[gpimIM1-9]*$/

/**
 * Parse a `sed -i 's/…/…/…' FILE` invocation, or return null when the command
 * is anything more than one clean single-file in-place substitution.
 */
export function parseSedEditCommand(command: string): SedEditInfo | null {
  const trimmed = command.trim()
  if (!/^sed\s/.test(trimmed)) return null
  const parse = tryParseShellCommand(trimmed.replace(/^sed\s+/, ''))
  if (!parse.success) return null

  // A glob token could match many files — refuse. Every other non-string token
  // (an operator that survived the tokenise) is silently discarded.
  const words: string[] = []
  for (const token of parse.tokens) {
    if (typeof token === 'string') {
      words.push(token)
      continue
    }
    if (isGlobToken(token)) return null
    // operator token: discarded
  }

  let inPlace = false
  let extendedRegex = false
  let program: string | null = null
  let filePath: string | null = null

  for (let i = 0; i < words.length; i++) {
    const word = words[i] as string
    if (word === '-i' || word === '--in-place') {
      inPlace = true
      // Conditionally consume a following macOS backup suffix: only when it does
      // not begin with `-` and is empty or begins with `.`.
      const next = words[i + 1]
      if (next !== undefined && !next.startsWith('-') && (next === '' || next.startsWith('.'))) {
        i++
      }
      continue
    }
    if (word.startsWith('-i')) {
      // The fused-suffix form (-i.bak); marks in-place, consumes nothing.
      // Note: `--in-place=SUFFIX` does not match `-i` on its first two chars.
      if (word.startsWith('--in-place=')) return null
      inPlace = true
      continue
    }
    if (word === '-E' || word === '-r' || word === '--regexp-extended') {
      extendedRegex = true
      continue
    }
    if (word === '-e' || word === '--expression') {
      const next = words[i + 1]
      if (next === undefined) return null
      if (program !== null) return null
      program = next
      i++
      continue
    }
    if (word.startsWith('--expression=')) {
      if (program !== null) return null
      program = word.slice('--expression='.length)
      continue
    }
    if (word.startsWith('-')) return null // unknown flag
    // A positional token: program first, then file path, then reject.
    if (program === null) {
      program = word
    } else if (filePath === null) {
      filePath = word
    } else {
      return null
    }
  }

  if (!inPlace || !program || !filePath) return null

  const parsed = parseSubstitutionProgram(program)
  if (!parsed) return null
  return { filePath, pattern: parsed.pattern, replacement: parsed.replacement, flags: parsed.flags, extendedRegex }
}

/** A `s/pat/rep/flags` program → its three fields, honouring backslash escapes. */
function parseSubstitutionProgram(program: string): { pattern: string; replacement: string; flags: string } | null {
  if (!program.startsWith('s/')) return null
  let state: 'pattern' | 'replacement' | 'flags' = 'pattern'
  let pattern = ''
  let replacement = ''
  let flags = ''
  for (let i = 2; i < program.length; i++) {
    const ch = program[i] as string
    if (ch === '\\' && i + 1 < program.length) {
      // Carry the escape (backslash + next char) into the current field.
      const pair = ch + (program[i + 1] as string)
      if (state === 'pattern') pattern += pair
      else if (state === 'replacement') replacement += pair
      else flags += pair
      i++
      continue
    }
    if (ch === '/') {
      if (state === 'pattern') state = 'replacement'
      else if (state === 'replacement') state = 'flags'
      else return null // a fourth delimiter while collecting flags
      continue
    }
    if (state === 'pattern') pattern += ch
    else if (state === 'replacement') replacement += ch
    else flags += ch
  }
  if (state !== 'flags') return null // fewer than two delimiters
  if (!ALLOWED_SED_FLAGS.test(flags)) return null
  return { pattern, replacement, flags }
}

/** Whether the command parses as an in-place sed edit. */
export function isSedInPlaceEdit(command: string): boolean {
  return parseSedEditCommand(command) !== null
}

// ── applying the substitution ─────────────────────────────────────────

/** An internal marker for a whole-match back-reference; not forgeable from input. */
const WHOLE_MATCH_MARKER = '\x00MERCURY_SED_WHOLE_MATCH\x00'

/** Apply a parsed sed substitution to content; return the input unchanged on an invalid pattern. */
export function applySedSubstitution(content: string, sedInfo: SedEditInfo): string {
  const global = sedInfo.flags.includes('g')
  const caseInsensitive = sedInfo.flags.includes('i') || sedInfo.flags.includes('I')
  const multiline = sedInfo.flags.includes('m') || sedInfo.flags.includes('M')
  let regexFlags = ''
  if (global) regexFlags += 'g'
  if (caseInsensitive) regexFlags += 'i'
  if (multiline) regexFlags += 'm'

  const pattern = translatePattern(sedInfo.pattern, sedInfo.extendedRegex)
  const replacement = translateReplacement(sedInfo.replacement)

  let regex: RegExp
  try {
    regex = new RegExp(pattern, regexFlags)
  } catch {
    return content // an invalid pattern shows no diff, never throws
  }
  return content.replace(regex, match =>
    replacement.split(WHOLE_MATCH_MARKER).join(match),
  )
}

/** Translate a sed pattern to the host regex dialect. */
function translatePattern(pattern: string, extendedRegex: boolean): string {
  // First, an escaped delimiter `\/` becomes a plain `/`.
  let out = pattern.replace(/\\\//g, '/')
  if (extendedRegex) return out
  // Basic → extended: swap the five metacharacter pairs simultaneously.
  // A literal escaped backslash must survive as a literal backslash.
  let result = ''
  for (let i = 0; i < out.length; i++) {
    const ch = out[i] as string
    if (ch === '\\') {
      const next = out[i + 1]
      if (next === '\\') {
        result += '\\\\' // a literal backslash, carried through untouched
        i++
        continue
      }
      if (next !== undefined && '+?|()'.includes(next)) {
        result += next // `\+` → `+` (a metacharacter in the host engine)
        i++
        continue
      }
      result += '\\' + (next ?? '')
      if (next !== undefined) i++
      continue
    }
    if ('+?|()'.includes(ch)) {
      result += '\\' + ch // bare `+` → literal `\+`
      continue
    }
    result += ch
  }
  return result
}

/** Translate a sed replacement: `\/`→`/`, `\&`→literal `&`, unescaped `&`→whole match. */
function translateReplacement(replacement: string): string {
  let result = ''
  for (let i = 0; i < replacement.length; i++) {
    const ch = replacement[i] as string
    if (ch === '\\' && i + 1 < replacement.length) {
      const next = replacement[i + 1] as string
      if (next === '/') result += '/'
      else if (next === '&') result += '&' // literal ampersand
      else result += '\\' + next
      i++
      continue
    }
    if (ch === '&') {
      result += WHOLE_MATCH_MARKER
      continue
    }
    // A host-engine `$` token would otherwise be interpreted by String.replace;
    // the whole-match marker round-trips, but leave other `$` tokens as-is per
    // spec (they diverge deliberately — a preview-fidelity gap).
    result += ch
  }
  return result
}

/** Whether a shell-quote token is a glob. */
function isGlobToken(token: unknown): boolean {
  return typeof token === 'object' && token !== null && (token as { op?: string }).op === 'glob'
}
