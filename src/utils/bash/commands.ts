/**
 * The legacy shell-quote-based command splitter, redirection extractor,
 * help-command detector, and the model-based prefix-extraction wiring.
 *
 * This path is the live one in this build (the AST lane is stripped), and it
 * inherits every divergence of the third-party tokenizer from bash. Each
 * rule here exists because of a specific, documented bypass; the ordering
 * laws (heredoc extraction → continuation join → tokenise) are load-bearing
 * and must not be normalised into a single up-front pass.
 */
import type { ControlOperator, ParseEntry } from 'shell-quote'
import {
  createCommandPrefixExtractor,
  createSubcommandPrefixExtractor,
} from '../shell/prefix.js'
import type { CommandPrefixResult, CommandSubcommandPrefixResult } from '../shell/prefix.js'
import { extractHeredocs, restoreHeredocs } from './heredoc.js'
import { quote, tryParseShellCommand } from './shellQuote.js'

export type { CommandPrefixResult, CommandSubcommandPrefixResult } from '../shell/prefix.js'

// ─────────────────────────────────────────────────────────────────────────────
// Placeholder markers (salted per call — a security control, not hygiene)
// ─────────────────────────────────────────────────────────────────────────────

type Markers = {
  doubleQuote: string
  singleQuote: string
  newline: string
  escapedOpenParen: string
  escapedCloseParen: string
}

/** Mint fresh salted markers so literal marker-shaped text cannot forge one. */
function makeMarkers(): Markers {
  const salt = Math.floor(Math.random() * 0x1_0000_0000_0000).toString(16)
  // Shaped so the tokenizer treats each as a single ordinary word.
  return {
    doubleQuote: `MERCURYdq${salt}z`,
    singleQuote: `MERCURYsq${salt}z`,
    newline: `MERCURYnl${salt}z`,
    escapedOpenParen: `MERCURYop${salt}z`,
    escapedCloseParen: `MERCURYcp${salt}z`,
  }
}

/**
 * Protect quotes, newlines and escaped parens across tokenisation: the
 * tokenizer strips quotes and newlines and unescapes `\(`/`\)`. Each quote
 * keeps its character and gains a marker immediately after it, so the marker
 * survives inside the token when the quote is removed; each newline is
 * wrapped marker-side; `\(`/`\)` are replaced wholesale.
 */
function protect(text: string, markers: Markers): string {
  let out = ''
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (ch === '"') {
      out += `"${markers.doubleQuote}`
    } else if (ch === "'") {
      out += `'${markers.singleQuote}`
    } else if (ch === '\n') {
      out += `\n${markers.newline}\n`
    } else if (ch === '\\' && text[i + 1] === '(') {
      out += markers.escapedOpenParen
      i++
    } else if (ch === '\\' && text[i + 1] === ')') {
      out += markers.escapedCloseParen
      i++
    } else {
      out += ch
    }
  }
  return out
}

/** Restore a protected fragment back to its original characters. */
function restore(text: string, markers: Markers): string {
  return text
    .split(markers.doubleQuote)
    .join('"')
    .split(markers.singleQuote)
    .join("'")
    .split(markers.escapedOpenParen)
    .join('\\(')
    .split(markers.escapedCloseParen)
    .join('\\)')
}

// ─────────────────────────────────────────────────────────────────────────────
// Line-continuation joining (parity-sensitive)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Join line continuations: a run of backslashes before a newline is a
 * continuation only when its count is ODD (the escaping backslash and the
 * newline are both removed, and NO space is inserted — bash joins the tokens
 * directly). An even run pairs up and the newline stays a separator. Only a
 * bare newline terminates the run; a CRLF sequence is not joined.
 */
function joinLineContinuations(text: string): string {
  let out = ''
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\\') {
      let run = 0
      let j = i
      while (j < text.length && text[j] === '\\') {
        run++
        j++
      }
      if (text[j] === '\n' && run % 2 === 1) {
        // Emit the paired-off backslashes, drop the escaping one and the
        // newline, and continue directly after the newline.
        out += '\\'.repeat(run - 1)
        i = j // loop's i++ steps past the newline
        continue
      }
      out += '\\'.repeat(run)
      i = j - 1
      continue
    }
    out += text[i]
  }
  return out
}

// ─────────────────────────────────────────────────────────────────────────────
// Operator sets (contract data)
// ─────────────────────────────────────────────────────────────────────────────

const CONTROL_OPERATOR_TOKENS: ReadonlySet<string> = new Set([
  '&&',
  '||',
  ';',
  ';;',
  '|',
  '>&',
  '>',
  '>>',
])

function operatorText(entry: ParseEntry): string | null {
  if (typeof entry === 'object' && entry !== null && 'op' in entry) {
    return (entry as { op: ControlOperator['op'] | 'glob' }).op
  }
  return null
}

/** An environment callback mapping each variable name back to its `$NAME`. */
function preserveVariables(key: string): string {
  return `$${key}`
}

// ─────────────────────────────────────────────────────────────────────────────
// Split into commands and operators
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Split a command into an ordered list mixing command fragments and operator
 * tokens. Ordering law (fixed after live bypasses, never reorder): extract
 * heredocs → join continuations on the heredoc-processed text → tokenise.
 * On tokenisation failure the result is a single element, the
 * continuation-joined ORIGINAL (never the raw original — that lets a
 * dangerous pattern hide across a continuation).
 */
export function splitCommandWithOperators(command: string): string[] {
  if (command.trim() === '') return []

  const markers = makeMarkers()
  const { processedCommand, heredocs } = extractHeredocs(command)
  const joined = joinLineContinuations(processedCommand)
  const joinedOriginal = joinLineContinuations(command)

  const parseResult = tryParseShellCommand(protect(joined, markers), preserveVariables)
  if (!parseResult.success) {
    return restoreHeredocs([joinedOriginal], heredocs)
  }

  const fragments: string[] = []
  let currentString: string | null = null

  const flush = (): void => {
    if (currentString !== null) {
      fragments.push(currentString)
      currentString = null
    }
  }

  for (const entry of parseResult.tokens) {
    if (typeof entry === 'string') {
      // The protected newline marker survives as a bare string token when
      // the tokenizer consumed the surrounding newlines.
      if (entry === markers.newline) {
        if (currentString !== null) {
          // Preceding collapsed entry is a string: terminate and restart.
          flush()
        } else {
          // First token, or directly after an operator: the marker is kept
          // as an ordinary token; restore cannot match it, so its raw text
          // remains (faithfully reproduced quirk, slice spec).
          currentString = entry
        }
        continue
      }
      currentString = currentString === null ? entry : `${currentString} ${entry}`
      continue
    }

    const op = operatorText(entry)
    if (op === 'glob') {
      // An unquoted glob collapses into the preceding string fragment when
      // that fragment is a string.
      const pattern = (entry as { pattern: string }).pattern
      currentString = currentString === null ? pattern : `${currentString} ${pattern}`
      continue
    }
    if ('comment' in entry) {
      // Re-emit as a `#`-prefixed string, de-duplicating injected quote
      // markers first (each quote-plus-marker pair collapses to the marker
      // alone) so restoration does not double every quote — unbounded growth
      // under recursive splitting is a real DoS.
      flush()
      const commentText = dedupeQuoteMarkers((entry as { comment: string }).comment, markers)
      fragments.push(`#${commentText}`)
      continue
    }
    // A control/redirection operator.
    flush()
    if (op !== null) fragments.push(op)
  }
  flush()

  const restored = fragments.map(fragment => restore(fragment, markers))
  return restoreHeredocs(restored, heredocs)
}

/** Collapse each quote-plus-marker pair to the marker alone (comment path). */
function dedupeQuoteMarkers(text: string, markers: Markers): string {
  return text
    .split(`"${markers.doubleQuote}`)
    .join(markers.doubleQuote)
    .split(`'${markers.singleQuote}`)
    .join(markers.singleQuote)
}

/** Remove the supported control-operator tokens from a split list. */
export function filterControlOperators(parts: string[]): string[] {
  return parts.filter(part => !CONTROL_OPERATOR_TOKENS.has(part))
}

// ─────────────────────────────────────────────────────────────────────────────
// Split into commands with redirections stripped
// ─────────────────────────────────────────────────────────────────────────────

const RECOGNISED_DESCRIPTORS: ReadonlySet<string> = new Set(['0', '1', '2'])

/** A redirect target is static only when it is a single, safe shell word. */
function isStaticRedirectTarget(target: string): boolean {
  if (target === '') return false
  if (/[\s'"]/.test(target)) return false
  if (target.startsWith('#') || target.startsWith('!') || target.startsWith('=') || target.startsWith('&')) {
    return false
  }
  if (/[$`*?[{~(<]/.test(target)) return false
  return true
}

/**
 * Split into commands with redirections dropped, so redirect targets do not
 * appear as separate "commands" in a permission prompt (they are validated
 * elsewhere). Built on the operator split above.
 */
export function splitCommand_DEPRECATED(command: string): string[] {
  const parts = splitCommandWithOperators(command)
  const stripped: (string | undefined)[] = []

  for (let i = 0; i < parts.length; i++) {
    const token = parts[i] as string

    if (token === '>&') {
      // `>&` followed by a bare descriptor.
      const next = parts[i + 1]
      if (next !== undefined && RECOGNISED_DESCRIPTORS.has(next)) {
        // The fd digit before the dup goes with it — `cmd 2>&1` splits to
        // ["cmd"], never ["cmd 2"] — mirroring the `>`/`>>` branch's strip.
        if (stripped.length > 0) {
          const prevIndex = stripped.length - 1
          const prev = stripped[prevIndex]
          if (typeof prev === 'string') {
            if (
              prev.length >= 3 &&
              RECOGNISED_DESCRIPTORS.has(prev[prev.length - 1] as string) &&
              prev[prev.length - 2] === ' '
            ) {
              stripped[prevIndex] = prev.slice(0, -2)
            } else if (RECOGNISED_DESCRIPTORS.has(prev)) {
              // A standalone fd digit token is removed outright.
              stripped[prevIndex] = undefined
            }
          }
        }
        i += 1
        continue
      }
    }
    if (token === '>' || token === '>>') {
      const a = parts[i + 1]
      // `>` `&` `<descriptor>` (three tokens).
      if (a === '&' && parts[i + 2] !== undefined && RECOGNISED_DESCRIPTORS.has(parts[i + 2] as string)) {
        i += 2
        continue
      }
      // `>` `&<descriptor>` (two tokens).
      if (a !== undefined && a.startsWith('&') && RECOGNISED_DESCRIPTORS.has(a.slice(1))) {
        i += 1
        continue
      }
      // `>`/`>>` followed by a static target.
      if (a !== undefined && !CONTROL_OPERATOR_TOKENS.has(a)) {
        let target = a
        // `> /dev/null 2>&1` special case: split a trailing descriptor off
        // the merged token before the static test.
        const following = parts[i + 2]
        if (
          target.length >= 3 &&
          RECOGNISED_DESCRIPTORS.has(target[target.length - 1] as string) &&
          target[target.length - 2] === ' ' &&
          (following === '>' || following === '>>' || following === '>&')
        ) {
          target = target.slice(0, -2)
        }
        if (isStaticRedirectTarget(target)) {
          // Remove a trailing descriptor from the PRECEDING fragment only
          // when it is long enough and space-separated.
          if (stripped.length > 0) {
            const prevIndex = stripped.length - 1
            const prev = stripped[prevIndex]
            if (
              typeof prev === 'string' &&
              prev.length >= 3 &&
              RECOGNISED_DESCRIPTORS.has(prev[prev.length - 1] as string) &&
              prev[prev.length - 2] === ' '
            ) {
              stripped[prevIndex] = prev.slice(0, -2)
            }
          }
          i += 1 // consume the target
          continue
        }
      }
    }

    stripped.push(token)
  }

  const cleaned = stripped.filter((entry): entry is string => entry !== undefined && entry !== '')
  return filterControlOperators(cleaned)
}

// ─────────────────────────────────────────────────────────────────────────────
// Compound-command safety classification
// ─────────────────────────────────────────────────────────────────────────────

/** Whether a command is "just a list of commands" (quotes-only protection). */
function isPlainCommandList(command: string): boolean {
  const markers = makeMarkers()
  const { processedCommand } = extractHeredocs(command)
  // Quotes only — no newline or paren markers, so a bare newline is mere
  // whitespace to the tokenizer and does not by itself make a command unsafe.
  const protectedText = protectQuotesOnly(processedCommand, markers)
  const parseResult = tryParseShellCommand(protectedText, preserveVariables)
  if (!parseResult.success) return false

  const tokens = parseResult.tokens
  for (let i = 0; i < tokens.length; i++) {
    const entry = tokens[i] as ParseEntry
    if (typeof entry === 'string') continue
    const op = operatorText(entry)
    if (op === 'glob') continue
    if (op === '&&' || op === '||' || op === ';' || op === ';;' || op === '|') continue
    if (op === '>' || op === '>>') continue
    if (op === '>&') {
      const next = tokens[i + 1]
      if (
        typeof next === 'string' &&
        RECOGNISED_DESCRIPTORS.has(restore(next, markers).trim())
      ) {
        continue
      }
      return false
    }
    // Any comment token, or any other operator, makes it unsafe.
    return false
  }
  return true
}

/** Protect only quote characters (the safety-classification path). */
function protectQuotesOnly(text: string, markers: Markers): string {
  let out = ''
  for (const ch of text) {
    if (ch === '"') out += `"${markers.doubleQuote}`
    else if (ch === "'") out += `'${markers.singleQuote}`
    else out += ch
  }
  return out
}

/**
 * Whether a command is an unsafe compound command: tokenisation of the
 * heredoc-processed command fails (this probe tokenises WITHOUT quote
 * protection — defence in depth, never rely on the shell rejecting malformed
 * syntax), or the command splits into more than one command and is not a
 * plain list.
 */
export function isUnsafeCompoundCommand_DEPRECATED(command: string): boolean {
  const { processedCommand } = extractHeredocs(command)
  const bareProbe = tryParseShellCommand(processedCommand, preserveVariables)
  if (!bareProbe.success) return true

  const commands = splitCommand_DEPRECATED(command)
  if (commands.length > 1 && !isPlainCommandList(command)) {
    return true
  }
  return false
}

// ─────────────────────────────────────────────────────────────────────────────
// Output-redirection extraction
// ─────────────────────────────────────────────────────────────────────────────

export type OutputRedirectionCapture = {
  target: string
  operator: '>' | '>>'
}

export type OutputRedirectionResult = {
  commandWithoutRedirections: string
  redirections: OutputRedirectionCapture[]
  hasDangerousRedirection: boolean
}

/** A redirect target holds a dangerous expansion the user must be asked about. */
function hasDangerousExpansion(target: string): boolean {
  if (/[$%`*?[{]/.test(target)) return true
  if (target.startsWith('!') || target.startsWith('=') || target.startsWith('~')) return true
  return false
}

/** History-expansion spellings excluded from zsh force-clobber `!` stripping. */
function isHistoryExpansion(rest: string): boolean {
  return (
    rest.startsWith('!') ||
    rest.startsWith('-') ||
    rest.startsWith('?') ||
    /^[0-9]/.test(rest)
  )
}

/**
 * Extract output redirections: the command with them removed, the captured
 * target/operator pairs, and a dangerous-redirection flag. Ordering law
 * (never reorder): extract heredocs → join continuations → tokenise. On
 * tokenisation failure, fail closed — return the ORIGINAL command, no
 * redirections, dangerous = true.
 *
 * The totality invariant is the law: every string redirect target is either
 * a simple target (captured, path-validated downstream) or has a dangerous
 * expansion (flagged, user asked). A target that satisfies neither is never
 * validated, so nothing may fall between the two.
 */
export function extractOutputRedirections(cmd: string): OutputRedirectionResult {
  const markers = makeMarkers()
  const { processedCommand, heredocs } = extractHeredocs(cmd)
  const joined = joinLineContinuations(processedCommand)

  // The tokenise gate keeps the fail-closed contract: text the tokenizer
  // cannot parse is never scanned for redirects.
  const parseResult = tryParseShellCommand(protect(joined, markers), preserveVariables)
  if (!parseResult.success) {
    return { commandWithoutRedirections: cmd, redirections: [], hasDangerousRedirection: true }
  }

  const redirections: OutputRedirectionCapture[] = []
  let hasDangerousRedirection = false

  // Span-based scan over the joined text: quote-aware, substitution-aware.
  // The reconstruction is the ORIGINAL text minus only the removed spans, so
  // argument quoting, `$(...)` shapes and descriptor dups survive verbatim.
  type Span = { start: number; end: number }
  const removals: Span[] = []
  let mode: 'none' | 'single' | 'double' = 'none'
  let substitutionDepth = 0

  const text = joined
  for (let i = 0; i < text.length; i++) {
    const ch = text[i] as string
    if (mode !== 'single' && ch === '\\') {
      i++
      continue
    }
    if (ch === "'" && mode !== 'double') {
      mode = mode === 'single' ? 'none' : 'single'
      continue
    }
    if (ch === '"' && mode !== 'single') {
      mode = mode === 'double' ? 'none' : 'double'
      continue
    }
    if (mode !== 'none') continue
    if (ch === '$' && text[i + 1] === '(') {
      substitutionDepth++
      i++
      continue
    }
    if (ch === ')' && substitutionDepth > 0) {
      substitutionDepth--
      continue
    }
    if (substitutionDepth > 0) continue
    if (ch === '#' && (i === 0 || /[\s;|&(]/.test(text[i - 1] as string))) {
      // An unquoted comment runs to end of line: a `>` inside it is NOT a
      // redirect — nothing captured, nothing flagged, and the comment text
      // stays in the reconstruction untouched.
      while (i < text.length && text[i] !== '\n') i++
      continue
    }
    if (ch !== '>') continue

    // A write-redirect operator begins here. Look back for an fd prefix.
    let spanStart = i
    let fd: string | null = null
    const before = text[i - 1]
    if (before !== undefined && /[012]/.test(before)) {
      const beforeBefore = text[i - 2]
      if (beforeBefore === undefined || /\s/.test(beforeBefore) || /[;|&(]/.test(beforeBefore)) {
        fd = before
        spanStart = i - 1
      }
    }

    // Longest-match the operator body.
    let j = i
    let append = false
    let combined = false // >& family (stdout+stderr, or fd dup)
    j++ // past the first '>'
    if (text[j] === '>') {
      append = true
      j++
    }
    if (text[j] === '&') {
      combined = true
      j++
    }
    // Fused force-clobber / zsh markers directly after the operator.
    let sawForceMarker = false
    if (text[j] === '|') {
      sawForceMarker = true
      j++
    } else if (text[j] === '!') {
      // `>!target` — a zsh force-clobber unless a history-expansion spelling.
      const rest = text.slice(j + 1)
      if (!isHistoryExpansion(rest)) {
        sawForceMarker = true
        j++
      }
    }
    // Spaced markers: `> | target`, `> ! target` (and the >& forms).
    let k = j
    while (text[k] === ' ' || text[k] === '\t') k++
    if (!sawForceMarker) {
      if (text[k] === '|' && (text[k + 1] === ' ' || text[k + 1] === '\t')) {
        sawForceMarker = true
        k++
        while (text[k] === ' ' || text[k] === '\t') k++
      } else if (text[k] === '!' && (text[k + 1] === ' ' || text[k + 1] === '\t')) {
        sawForceMarker = true
        k++
        while (text[k] === ' ' || text[k] === '\t') k++
      }
    }
    void sawForceMarker

    // Read the target as ONE quote-aware shell word: quoted regions continue
    // the word through spaces, and the EFFECTIVE content (quote characters
    // removed) is what gets captured — quoting alone is not a shell
    // expansion, so `a"b"` is a static target, not a dangerous one.
    const targetStart = k
    let target = ''
    let isQuotedTarget = false
    while (k < text.length) {
      const c = text[k] as string
      if (c === "'" || c === '"') {
        isQuotedTarget = true
        k++
        while (k < text.length && text[k] !== c) {
          target += text[k]
          k++
        }
        if (k < text.length) k++ // the closing quote
        continue
      }
      if (/[\s;|&<>()]/.test(c)) break
      target += c
      k++
    }
    const spanEnd = k

    if (target === '' && !isQuotedTarget) {
      // No target word (for example a trailing `>` or `>&` at end): leave the
      // text untouched; the tokenizer-level callers handle the malformed case.
      i = j - 1
      continue
    }

    // zsh fused `!` on the captured target (the written path is the
    // remainder) — only when the word STARTS with an unquoted `!`.
    let capturedTarget = restore(target, markers)
    if (
      text[targetStart] === '!' &&
      capturedTarget.startsWith('!') &&
      !isHistoryExpansion(capturedTarget.slice(1))
    ) {
      capturedTarget = capturedTarget.slice(1)
    }

    // A pure descriptor dup (`2>&1`, `>&2`): neither captured nor flagged; the
    // span stays verbatim in the reconstruction.
    if (combined && /^[0-9]+$/.test(capturedTarget)) {
      i = spanEnd - 1
      continue
    }

    // Totality law: every remaining target is exactly one of captured|flagged.
    const operator: '>' | '>>' = append ? '>>' : '>'
    if (!isQuotedTarget && (!isStaticRedirectTarget(capturedTarget) || hasDangerousExpansion(capturedTarget))) {
      hasDangerousRedirection = true
      i = spanEnd - 1
      continue
    }
    if (isQuotedTarget && hasDangerousExpansion(capturedTarget)) {
      hasDangerousRedirection = true
      i = spanEnd - 1
      continue
    }
    redirections.push({ target: capturedTarget, operator })
    // Non-stdout fd file redirects keep their span in the reconstruction;
    // stdout (or fd-less) captures are removed.
    if (fd === null || fd === '1') {
      // Extend over the whitespace immediately before the operator.
      let ws = spanStart
      while (ws > 0 && (text[ws - 1] === ' ' || text[ws - 1] === '\t')) ws--
      removals.push({ start: ws, end: spanEnd })
    }
    i = spanEnd - 1
    void targetStart
  }

  // Cut the removal spans (back to front).
  let reconstruction = text
  for (const span of removals.sort((a, b) => b.start - a.start)) {
    reconstruction = reconstruction.slice(0, span.start) + reconstruction.slice(span.end)
  }
  reconstruction = reconstruction.trim()
  if (reconstruction === '') {
    reconstruction = joined.trim()
  }
  const restoredReconstruction = restoreHeredocs([restore(reconstruction, markers)], heredocs)[0] as string

  return {
    commandWithoutRedirections: restoredReconstruction,
    redirections,
    hasDangerousRedirection,
  }
}

/** Quote a reconstruction fragment per the downstream-matcher rules. */
function quoteFragmentForReconstruction(fragment: string): string {
  if (/[|&;]/.test(fragment)) {
    return `"${fragment}"`
  }
  if (/[\s]/.test(fragment)) {
    return quote([fragment])
  }
  return fragment
}

// ─────────────────────────────────────────────────────────────────────────────
// Help-command shortcut
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A help command: after trimming it ends with `--help`; it contains no quote
 * characters; it tokenises; every string token starting with `-` is exactly
 * `--help` (at least one seen); and every other string token is purely
 * alphanumeric. Operators, globs and comments are not examined, so a command
 * with operators can still qualify.
 */
export function isHelpCommand(command: string): boolean {
  const trimmed = command.trim()
  if (!trimmed.endsWith('--help')) return false
  if (trimmed.includes('"') || trimmed.includes("'")) return false

  const parseResult = tryParseShellCommand(trimmed, preserveVariables)
  if (!parseResult.success) return false

  let sawHelpFlag = false
  for (const entry of parseResult.tokens) {
    if (typeof entry !== 'string') continue
    if (entry.startsWith('-')) {
      if (entry !== '--help') return false
      sawHelpFlag = true
    } else if (!/^[A-Za-z0-9]+$/.test(entry)) {
      return false
    }
  }
  return sawHelpFlag
}

// ─────────────────────────────────────────────────────────────────────────────
// Model-based prefix extraction
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The policy document handed to the model. It defines what a "prefix" is for
 * a Bash command, so the permission chain can offer the user a narrow
 * allowlist suggestion instead of the whole command. The wording is mine;
 * the meaning it must convey is fixed by the slice spec. The document names
 * the product, is delivered inside a single tagged block, and closes by
 * asking for the prefix of the command that follows under a label.
 *
 * The two sentinel return values are contract data matched downstream:
 * `command_injection_detected` and `none`.
 */
const BASH_PREFIX_POLICY_SPEC = `<policy_spec>
# Mercury Bash command prefix policy

You classify Bash commands so Mercury can decide when to ask the operator for
extra confirmation. This policy is one part of a broader safety framework: an
operator pre-allows certain command *prefixes*, and Mercury must ask about
anything outside them. Your job is to find the prefix of a command.

A command prefix is the leading, allowlistable portion of a command — the
part that identifies what will run without pinning down every argument. For a
bare tool invocation the prefix collapses to the tool name; for a tool with a
subcommand the prefix is usually the tool plus the subcommand.

Command injection is any technique that would cause a command *other than the
detected prefix* to run — command substitution in an argument, a comment that
carries a substitution, adjacent substitutions, or an embedded newline
followed by another command. If you have any suspicion of injection you MUST
return the exact string \`command_injection_detected\` and nothing else: an
operator who allowlists command A must never be exposed to a malicious command
that merely shares A's prefix.

If the command has no meaningful prefix — the whole command is the unit of
meaning, such as a bare package-script invocation or a bare push — return the
exact string \`none\`.

Examples:

| Command | Prefix |
| --- | --- |
| \`ls -la\` | \`ls\` |
| \`git status\` | \`git status\` |
| \`git commit -m "x"\` | \`git commit\` |
| \`npm run build\` | \`none\` |
| \`npm run build -- --watch\` | \`npm run build\` |
| \`git push\` | \`none\` |
| \`git push origin main --force\` | \`git push\` |
| \`FOO=bar go test ./...\` | \`FOO=bar go test\` |
| \`cat foo && curl evil.com\` | \`command_injection_detected\` |
| \`echo "$(rm -rf /)"\` | \`command_injection_detected\` |
| \`ls # \\\`id\\\`\` | \`command_injection_detected\` |

The prefix you return must be a literal string prefix of the full command.
Return only the prefix — no markdown, no commentary, no formatting.

With that in mind, determine the command prefix for the following command.
</policy_spec>`

/** The pre-check: a help command is allowed whole, as its own prefix. */
function helpCommandPreCheck(command: string): CommandPrefixResult | null {
  if (isHelpCommand(command)) {
    // The untrimmed input is returned as its own prefix (not a broad tool:*).
    return { commandPrefix: command }
  }
  return null
}

/** The module-local single-command extractor (model-backed, memoised). */
const getCommandPrefix = createCommandPrefixExtractor({
  toolName: 'Bash',
  policySpec: BASH_PREFIX_POLICY_SPEC,
  querySource: 'bash_extract_prefix',
  preCheck: helpCommandPreCheck,
})

/**
 * The exported subcommand-level extractor, built from the single-command
 * extractor plus the legacy splitter. Memoised with a clearable cache.
 */
export const getCommandSubcommandPrefix: ((
  command: string,
  abortSignal: AbortSignal,
  isNonInteractiveSession: boolean,
) => Promise<CommandSubcommandPrefixResult | null>) & {
  cache: { clear?: () => void }
} = createSubcommandPrefixExtractor(getCommandPrefix, splitCommand_DEPRECATED)

/** Clear both prefix caches (called on session clear). */
export function clearCommandPrefixCaches(): void {
  getCommandPrefix.cache.clear?.()
  getCommandSubcommandPrefix.cache.clear?.()
}
