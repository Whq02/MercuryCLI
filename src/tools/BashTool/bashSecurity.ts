/**
 * The legacy regex/quote-tracking security validator battery.
 *
 * This module answers one question: could two different shell parsers disagree
 * about what this command does? A disagreement is how an attacker hides a
 * dangerous construct — a byte the tokeniser treats one way and bash treats
 * another. Because the structured (tree-sitter) parse lane is folded out of
 * this build, this battery is the real security floor: every Bash command that
 * reaches it either passes cleanly, or is forced to a human prompt with an
 * honest reason. The posture is fail-safe — when in doubt, ask.
 *
 * Two entry points, sync and async, share one validator ordering. An `ask`
 * result may carry a "misparsing concern" flag; the caller blocks early on a
 * flagged ask rather than routing it through the ordinary flow.
 */
import type { PermissionResult } from '../../utils/permissions/PermissionResult.js'
import {
  extractHeredocs,
  hasMalformedTokens,
  hasShellQuoteSingleQuoteBug,
  tryParseShellCommand,
} from '../../utils/permissions/decision/commandAnalysis.js'

// ── result plumbing ─────────────────────────────────────────────────────────

/** Internal verdict from one validator. */
type Verdict =
  | { kind: 'pass' }
  | { kind: 'ask'; message: string; misparsing: boolean }
  | { kind: 'allow'; reason: string }

const PASS: Verdict = { kind: 'pass' }
const ask = (message: string, misparsing: boolean): Verdict => ({ kind: 'ask', message, misparsing })
const allow = (reason: string): Verdict => ({ kind: 'allow', reason })

/** The shared "quoted characters in a flag name" message (validator 2 + the final unquoted checks + git-commit hyphen case). */
const FLAG_NAME_MESSAGE =
  'A quoted or concatenated flag name can hide a dangerous option from safety checks, so this command needs approval.'

/** Map an internal verdict to the caller-facing permission result. */
function toResult(verdict: Verdict): PermissionResult {
  switch (verdict.kind) {
    case 'pass':
      return { behavior: 'passthrough', message: 'All security checks passed.' }
    case 'allow':
      // An early allow is normalised to passthrough carrying its reason.
      return { behavior: 'passthrough', message: verdict.reason }
    case 'ask':
      return {
        behavior: 'ask',
        message: verdict.message,
        isBashSecurityCheckForMisparsing: verdict.misparsing,
      }
  }
}

// ── control-character pre-gate ──────────────────────────────────────────────

/** Blocked control bytes: the shell drops/ignores these but the validators treat them as ordinary. */
const CONTROL_CHAR_RE = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/

// ── the six command views ───────────────────────────────────────────────────

type Views = {
  original: string
  baseCommand: string
  /** single-quoted regions removed; double-quoted content kept; quote chars dropped. */
  withDoubleQuotes: string
  /** both quote kinds' content kept; quote chars dropped; safe redirections stripped. */
  fullyUnquoted: string
  /** the fully-unquoted content before safe-redirection stripping. */
  fullyUnquotedPreStrip: string
  /** quoted content removed; quote characters kept. */
  keepQuoteChars: string
}

/**
 * Walk the command tracking quote state, emitting the derived views. Backslash
 * is an escape everywhere except inside single quotes; an escaped character is
 * emitted literally with its backslash and does not toggle quote state.
 */
function buildViews(original: string, quoteSource: string): Views {
  let withDoubleQuotes = ''
  let fullyUnquotedPreStrip = ''
  let keepQuoteChars = ''
  let mode: 'none' | 'single' | 'double' = 'none'
  // jq mode: the double-quote CHARACTERS are retained in the double-quotes-
  // preserved view so the filter is analysed intact — with the observed quirk
  // reproduced: the fully-unquoted view receives only the CLOSING double
  // quotes (the opener is dropped because the toggle has already turned the
  // region on), and the quote-chars-preserved view receives each closing
  // double quote TWICE.
  const jqMode = /^jq(?:\s|$)/.test(original)

  for (let i = 0; i < quoteSource.length; i++) {
    const ch = quoteSource[i] as string
    if (mode !== 'single' && ch === '\\' && i + 1 < quoteSource.length) {
      // Escape: retain the backslash and the escaped character in the content
      // views; it does not toggle quote state.
      const next = quoteSource[i + 1] as string
      fullyUnquotedPreStrip += ch + next
      if (mode === 'none' || mode === 'double') withDoubleQuotes += ch + next
      if (mode === 'none') keepQuoteChars += ch + next
      i++
      continue
    }
    if (mode === 'none') {
      if (ch === "'") {
        mode = 'single'
        keepQuoteChars += ch
        continue
      }
      if (ch === '"') {
        mode = 'double'
        keepQuoteChars += ch
        if (jqMode) withDoubleQuotes += ch
        continue
      }
      withDoubleQuotes += ch
      fullyUnquotedPreStrip += ch
      keepQuoteChars += ch
      continue
    }
    if (mode === 'single') {
      if (ch === "'") {
        mode = 'none'
        keepQuoteChars += ch
        continue
      }
      // single-quoted content: kept only in the fully-unquoted view.
      fullyUnquotedPreStrip += ch
      continue
    }
    // mode === 'double'
    if (ch === '"') {
      mode = 'none'
      keepQuoteChars += ch
      if (jqMode) {
        withDoubleQuotes += ch
        fullyUnquotedPreStrip += ch // the closing quote only
        keepQuoteChars += ch // the closing quote a second time
      }
      continue
    }
    // double-quoted content: kept in withDoubleQuotes and fully-unquoted.
    withDoubleQuotes += ch
    fullyUnquotedPreStrip += ch
  }

  const firstSpace = original.indexOf(' ')
  const baseCommand = firstSpace === -1 ? original : original.slice(0, firstSpace)

  return {
    original,
    baseCommand,
    withDoubleQuotes,
    fullyUnquoted: stripSafeRedirections(fullyUnquotedPreStrip),
    fullyUnquotedPreStrip,
    keepQuoteChars,
  }
}

/**
 * Remove exactly three redirection shapes, each requiring a trailing boundary
 * (whitespace or end): stderr-to-stdout duplication, a redirect to the null
 * device, and an input redirect from the null device. The boundary is what
 * stops a path that merely *begins* with the null-device path from being
 * stripped.
 */
function stripSafeRedirections(text: string): string {
  // Exactly three shapes: (1) the stderr-to-stdout dup, whitespace tolerated
  // around `>&`, with a leading-whitespace boundary; (2) a SINGLE `>` to the
  // null device with an optional single 0/1/2 descriptor — never an append
  // `>>`, never a multi-digit fd, so `cmd >>/dev/null` reaches the redirection
  // validator; (3) an input redirect from the null device.
  return text
    .replace(/(?<=\s)2\s*>&\s*1(?=\s|$)/g, ' ')
    .replace(/(?<![\d>])[012]?>(?!>)\s*\/dev\/null(?=\s|$)/g, ' ')
    .replace(/<\s*\/dev\/null(?=\s|$)/g, ' ')
}

// ── heredoc-aware quote source ──────────────────────────────────────────────

/**
 * Produce the text the quote extraction reads: heredoc bodies are stripped
 * first, but only for quoted or escaped delimiters (a literal body). Unquoted
 * heredocs keep their bodies, because those bodies undergo expansion and a
 * validator must see them.
 */
function heredocProcessedForQuotes(command: string): string {
  try {
    const { processedCommand } = extractHeredocs(command)
    return processedCommand
  } catch {
    // The extractor bailed — send the raw command through every validator.
    return command
  }
}

// ── early validators ────────────────────────────────────────────────────────

/** 1. Empty command → allow. */
function checkEmpty(views: Views): Verdict {
  return views.original.trim() === '' ? allow('Empty command.') : PASS
}

/** 2. Incomplete fragment → ask (tab start / hyphen start / operator start). */
function checkIncompleteFragment(command: string): Verdict {
  if (/^\s*\t/.test(command) || command.startsWith('\t')) {
    return ask('The command begins with a tab, so it looks like an incomplete fragment.', true)
  }
  if (command.trim().startsWith('-')) {
    return ask('The command begins with what looks like stray flags.', true)
  }
  if (/^\s*(?:&&|\|\||;|>>|>|<)/.test(command)) {
    return ask('The command begins with a shell operator, so it looks like a continuation line.', true)
  }
  return PASS
}

// ── the safe-heredoc shape ──────────────────────────────────────────────────

/** Metacharacters that legitimately terminate a heredoc delimiter line tail. */
const HEREDOC_ALLOWED_REMAINDER = /^[A-Za-z0-9 \t'"./\-_@=,:+~]*$/

/**
 * Test whether a command is the one allowed safe-heredoc shape: a command
 * substitution containing `cat` reading a heredoc with a quoted or escaped
 * delimiter, in argument position, with no trailing metacharacters, whose
 * remainder itself passes the full battery.
 */
function isSafeHeredocSubstitution(command: string): boolean {
  const stripped = stripSafeHeredocSubstitutions(command)
  if (stripped === null) return false
  // In command-name position the substitution may not appear: the original
  // must have non-whitespace text before the first verified region.
  const firstOpen = command.indexOf('$(')
  if (firstOpen === -1) return false
  const before = command.slice(0, firstOpen)
  const remainder = stripped.trim()
  if (remainder !== '') {
    if (before.trim() === '') return false
    if (!HEREDOC_ALLOWED_REMAINDER.test(remainder)) return false
    // The remainder must itself be safe.
    if (bashCommandIsSafe_DEPRECATED(remainder).behavior === 'ask') return false
  }
  return true
}

/**
 * The permissive detect-and-strip: remove every command-substitution heredoc
 * region of the safe shape (quoted/escaped delimiter), returning the remainder
 * or null when none matched. It does not require argument position, does not
 * enforce the character allowlist, does not reject nesting and does not
 * recurse — it is the caller's misparsing-rescue helper.
 */
export function stripSafeHeredocSubstitutions(command: string): string | null {
  const opener = /(^|[^\\])\$\(\s*cat\s*<<-?\s*(\\?)(['"]?)([A-Za-z_]\w*)\3/g
  let match: RegExpExecArray | null
  const regions: Array<{ start: number; end: number }> = []
  let matchedAny = false

  while ((match = opener.exec(command)) !== null) {
    const escapedOrQuoted = match[2] === '\\' || match[3] === "'" || match[3] === '"'
    if (!escapedOrQuoted) continue
    const delimiter = match[4] as string
    const openStart = match.index + (match[1] ? match[1].length : 0)
    // The opening line must end after the delimiter.
    const openLineEnd = command.indexOf('\n', opener.lastIndex)
    if (openLineEnd === -1) continue
    const openTail = command.slice(opener.lastIndex, openLineEnd)
    if (openTail.trim() !== '') continue
    // Scan forward to the first line starting with the delimiter, then take
    // the first closing parenthesis at or after that line.
    const closeParen = findClosingParenAfterDelimiter(command, openLineEnd + 1, delimiter)
    if (closeParen === -1) continue
    regions.push({ start: openStart, end: closeParen + 1 })
    matchedAny = true
    opener.lastIndex = closeParen + 1
  }

  if (!matchedAny) return null
  // Remove the regions from the back so earlier indices stay valid.
  let result = command
  for (const region of regions.reverse()) {
    result = result.slice(0, region.start) + result.slice(region.end)
  }
  return result
}

/** From `fromIndex`, find the first line beginning with `delimiter`, then the first `)` at/after it. */
function findClosingParenAfterDelimiter(text: string, fromIndex: number, delimiter: string): number {
  const lines = text.slice(fromIndex).split('\n')
  let offset = fromIndex
  for (const line of lines) {
    const trimmedStart = line.replace(/^\t+/, '')
    if (trimmedStart.startsWith(delimiter)) {
      // A delimiter line immediately followed by a shell metacharacter is an
      // ambiguous early closure — reject by finding no paren.
      const after = trimmedStart.slice(delimiter.length)
      if (/^[;&|<>]/.test(after.trim())) return -1
      const parenOnLine = text.indexOf(')', offset)
      if (parenOnLine !== -1) return parenOnLine
    }
    offset += line.length + 1
  }
  return -1
}

// ── the safe git-commit shape ───────────────────────────────────────────────

/** 4. Simple git commit → allow, only for a provably safe shape. */
function checkSafeGitCommit(views: Views): Verdict {
  if (views.baseCommand !== 'git') return PASS
  if (!/^git\s+commit\s/.test(views.original)) return PASS
  // Any backslash disqualifies the shape (no backslash handling below).
  if (views.original.includes('\\')) return PASS

  // Parse a quoted message argument introduced by `-m`. Everything between
  // `git commit` and `-m` must exclude shell metacharacters, redirects AND
  // line breaks — a newline is a command separator, so a line placed between
  // `git commit` and `-m` is a second command bash would run; such a command
  // falls through to the main validators (where the newline validator asks).
  // At least one horizontal space must follow `commit` (`git commit-m …` is
  // not a commit shape at all).
  const match = views.original.match(
    /^git[ \t]+commit[ \t]+([^;&|<>()`$\n\r]*?)-m[ \t]+(['"])([\s\S]*?)\2([^\n]*)$/,
  )
  if (!match) return PASS
  const messageContent = match[3] as string
  const remainder = match[4] as string
  const doubleQuoted = match[2] === '"'

  // A double-quoted message with a substitution/backtick/param expansion → ask.
  if (doubleQuoted && /\$\(|`|\$\{/.test(messageContent)) {
    return ask('The commit message contains an expansion that would run at commit time.', false)
  }
  // A remainder carrying an operator / paren / backtick / substitution → bail.
  if (/[;&|()`]|\$\(|\$\{/.test(remainder)) return PASS
  // Redirect characters may appear inside quotes; strip quoted content and bail
  // if a redirect survives unquoted.
  const remainderUnquoted = remainder.replace(/'[^']*'/g, '').replace(/"[^"]*"/g, '')
  if (/[<>]/.test(remainderUnquoted)) return PASS
  // A hyphen-leading message content is an obfuscation shape.
  if (messageContent.startsWith('-')) return ask(FLAG_NAME_MESSAGE, false)
  return allow('Simple git commit.')
}

// ── main validators ─────────────────────────────────────────────────────────

/** 1. jq safety. */
function checkJq(views: Views): Verdict {
  if (views.baseCommand !== 'jq') return PASS
  if (/\bsystem\s*\(/.test(views.original)) {
    return ask('A jq `system(` call can run arbitrary commands.', false)
  }
  const afterCommand = views.original.replace(/^jq\b/, '').trim()
  if (/(?:^|\s)(?:-f\b|--from-file\b|--rawfile\b|--slurpfile\b|-L\b|--library-path\b)/.test(afterCommand)) {
    return ask('A jq flag that reads files or loads code needs approval.', false)
  }
  return PASS
}

/** 2. Obfuscated flags — the largest validator. */
function checkObfuscatedFlags(views: Views): Verdict {
  const command = views.original
  // echo with no shell-operator character anywhere is exempt.
  if (views.baseCommand === 'echo' && !/[|&;]/.test(command)) return PASS

  // ANSI-C quoting.
  if (/\$'/.test(command)) return ask('ANSI-C quoting can encode any character.', false)
  // Locale quoting.
  if (/\$"/.test(command)) return ask('Locale quoting can hide a flag.', false)
  // `$` + two quote chars + optional ws + hyphen.
  if (/\$['"]['"]\s*-/.test(command)) return ask('An empty special-quote pair before a dash can hide a flag.', false)
  // One or more empty quote pairs at a word start + optional ws + hyphen.
  if (/(?:^|\s)(?:''|"")+\s*-/.test(command)) return ask('An empty quote pair adjacent to a dash can hide a flag.', false)
  // Homogeneous empty pairs immediately followed by a quote char and a hyphen (concatenation primitive).
  if (/(?:'')+'-|(?:"")+"-/.test(command)) return ask(FLAG_NAME_MESSAGE, false)
  // Three or more consecutive quote chars at a word start.
  if (/(?:^|\s)(?:'{3,}|"{3,})/.test(command)) return ask('Consecutive quote characters at a word start look like flag obfuscation.', false)

  // The quote-state scan with two probes.
  const scanVerdict = scanForHiddenFlags(command)
  if (scanVerdict.kind !== 'pass') return scanVerdict

  // Finally, in the fully-unquoted view: ws + quote char + hyphen, or two quote chars + hyphen.
  if (/(?:^|\s)['"]-/.test(views.fullyUnquoted) || /['"]['"]-/.test(views.fullyUnquoted)) {
    return ask(FLAG_NAME_MESSAGE, false)
  }
  return PASS
}

/** The quote-state scan (validator 2's two probes). Backslash escapes only outside single quotes. */
function scanForHiddenFlags(command: string): Verdict {
  let mode: 'none' | 'single' | 'double' = 'none'
  for (let i = 0; i < command.length; i++) {
    const ch = command[i] as string
    if (mode !== 'single' && ch === '\\') {
      i++ // consume the escaped char
      continue
    }
    if (mode === 'none') {
      // Probe A — whitespace followed by an opening quote (single, double, backtick).
      if (i > 0 && /\s/.test(command[i - 1] as string) && (ch === "'" || ch === '"' || ch === '`')) {
        const probe = probeWhitespaceQuote(command, i, ch)
        if (probe.kind !== 'pass') return probe
      }
      // Probe B — whitespace followed by a hyphen.
      if (ch === '-' && i > 0 && /\s/.test(command[i - 1] as string)) {
        const probe = probeWhitespaceHyphen(command, i)
        if (probe.kind !== 'pass') return probe
      }
      if (ch === "'") mode = 'single'
      else if (ch === '"') mode = 'double'
      continue
    }
    if (mode === 'single') {
      if (ch === "'") mode = 'none'
      continue
    }
    if (ch === '"') mode = 'none'
  }
  return PASS
}

/** Probe A: whitespace + quote — read to the matching close quote and test the content. */
function probeWhitespaceQuote(command: string, openIndex: number, quote: string): Verdict {
  const close = command.indexOf(quote, openIndex + 1)
  if (close === -1) return PASS // unterminated quote never fires
  const content = command.slice(openIndex + 1, close)
  const after = command[close + 1] ?? ''
  if (/^-+[A-Za-z0-9$`]/.test(content)) return ask(FLAG_NAME_MESSAGE, false)
  if (/^-+$/.test(content) && /[A-Za-z0-9\\$\{`\-]/.test(after)) return ask(FLAG_NAME_MESSAGE, false)
  // Empty-or-all-hyphens content followed by adjacent quoted segments forming a flag.
  if (/^-*$/.test(content)) {
    let acc = content
    let idx = close + 1
    while (idx < command.length && (command[idx] === "'" || command[idx] === '"' || command[idx] === '`')) {
      const q = command[idx] as string
      const end = command.indexOf(q, idx + 1)
      if (end === -1) break
      const seg = command.slice(idx + 1, end)
      acc += seg
      if (/^-+[A-Za-z0-9]/.test(acc)) return ask(FLAG_NAME_MESSAGE, false)
      if (/[$`]/.test(seg) && /^-+$/.test(acc.slice(0, acc.length - seg.length))) return ask(FLAG_NAME_MESSAGE, false)
      idx = end + 1
    }
  }
  return PASS
}

/** Probe B: whitespace + hyphen — collect the flag token; a surviving ordinary quote char fires. */
function probeWhitespaceHyphen(command: string, hyphenIndex: number): Verdict {
  let token = ''
  let sawCut = false
  for (let i = hyphenIndex; i < command.length; i++) {
    const ch = command[i] as string
    if (/\s/.test(ch) || ch === '=') break
    // The cut -d exception: a `cut` delimiter value is legitimately quoted.
    if (/\bcut\b/.test(command) && token === '-d' && (ch === "'" || ch === '"' || ch === '`')) {
      sawCut = true
      break
    }
    // A quote whose next char cannot be part of a flag name ends the token.
    if (ch === "'" || ch === '"' || ch === '`') {
      const next = command[i + 1] ?? ''
      if (!/[A-Za-z0-9_\-'"]/.test(next)) break
    }
    token += ch
  }
  if (sawCut) return PASS
  if (/['"]/.test(token)) return ask(FLAG_NAME_MESSAGE, false)
  return PASS
}

/** 3. Shell metacharacters in a quoted argument (double-quotes-preserved view). */
function checkShellMetacharsInArgs(views: Views): Verdict {
  const view = views.withDoubleQuotes
  // In this view delimiter quotes are absent, an escaped quote keeps its
  // backslash, and a `'` that sat INSIDE a double-quoted region survives BARE.
  // The "quoted argument" test therefore fires only when a BARE (non-
  // backslashed) quote character delimits the word: a bare quote right after
  // start/whitespace, non-quote content holding an unescaped `;`/`&` (an
  // escaped separator is literal and harmless), a bare quote right before
  // whitespace/end. An argument written `"'a;b'"` yields the word `'a;b'` →
  // fires; a `jq` filter's retained `"` characters can fire it; a backslash-
  // escaped quote NEVER satisfies the delimiter test, so `perl -e "print
  // \"a;b\""` (word `\"a;b\"`) and a top-level `echo \"a;b\"` both pass.
  // Bare list separators (`sleep 6; echo one`) never reach here as quoted words.
  const quotedArg = /(?:^|\s)(['"])([^'"\s]*)\1(?=\s|$)/g
  let m: RegExpExecArray | null
  while ((m = quotedArg.exec(view)) !== null) {
    const content = (m[2] as string).replace(/\\[;&]/g, '')
    if (/[;&]/.test(content)) {
      return ask('A quoted argument contains a shell control character.', false)
    }
  }
  // find-style name/path/iname pattern whose metacharacter sits BETWEEN bare
  // quote characters (`-name "'*;*'"` yields `-name '*;*'` → fires; `-name
  // "*;*"` yields `-name *;*` → passes).
  if (/-(?:i?name|path)\s+(['"])[^'"\s]*[;|&][^'"\s]*\1(?=\s|$)/.test(view)) {
    return ask('A find pattern contains a shell control character.', false)
  }
  // regex predicate — same bare-quote-delimited requirement.
  if (/-regex\s+(['"])[^'"\s]*[;&][^'"\s]*\1(?=\s|$)/.test(view)) {
    return ask('A regex predicate contains a shell control character.', false)
  }
  return PASS
}

/** 4. Dangerous variables — a variable reference on either side of a redirect or pipe (fully unquoted). */
function checkDangerousVariables(views: Views): Verdict {
  const view = views.fullyUnquoted
  // The variable shape is `$` then a letter/underscore then word characters
  // (unbraced, no leading digit); the operator set is `|`, `>` AND the input
  // redirect `<` — a variable on either side of `<` fires this misparsing-
  // flagged ask rather than falling to the non-misparsing redirections rule.
  if (/\$[A-Za-z_]\w*\s*[|<>]|[|<>]\s*\$[A-Za-z_]\w*/.test(view)) {
    return ask('A variable reference next to a redirect or pipe can expand to an unexpected command.', false)
  }
  return PASS
}

/** 5. Comment/quote desync. */
function checkCommentDesync(command: string): Verdict {
  let mode: 'none' | 'single' | 'double' = 'none'
  for (let i = 0; i < command.length; i++) {
    const ch = command[i] as string
    if (mode !== 'single' && ch === '\\') {
      i++
      continue
    }
    if (mode === 'none') {
      if (ch === "'") mode = 'single'
      else if (ch === '"') mode = 'double'
      else if (ch === '#') {
        const eol = command.indexOf('\n', i)
        const rest = command.slice(i, eol === -1 ? command.length : eol)
        if (/['"]/.test(rest)) {
          return ask('An unquoted comment contains a quote character that can desynchronise quote tracking.', false)
        }
        i = eol === -1 ? command.length : eol
      }
      continue
    }
    if (mode === 'single') {
      if (ch === "'") mode = 'none'
      continue
    }
    if (ch === '"') mode = 'none'
  }
  return PASS
}

/** 6. Quoted newline before a hash line. */
function checkQuotedNewlineBeforeHash(command: string): Verdict {
  if (!command.includes('\n') || !command.includes('#')) return PASS
  let mode: 'none' | 'single' | 'double' = 'none'
  for (let i = 0; i < command.length; i++) {
    const ch = command[i] as string
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
    if (ch === '\n' && mode !== 'none') {
      const nextLine = command.slice(i + 1).replace(/^[ \t]*/, '')
      if (nextLine.startsWith('#')) {
        return ask('A newline inside quotes followed by a comment line can hide a path from validation.', false)
      }
    }
  }
  return PASS
}

/** 7. Carriage return outside double quotes (misparsing). */
function checkCarriageReturn(command: string): Verdict {
  let mode: 'none' | 'single' | 'double' = 'none'
  for (let i = 0; i < command.length; i++) {
    const ch = command[i] as string
    if (mode !== 'single' && ch === '\\') {
      i++
      continue
    }
    if (ch === "'" && mode !== 'double') mode = mode === 'single' ? 'none' : 'single'
    else if (ch === '"' && mode !== 'single') mode = mode === 'double' ? 'none' : 'double'
    else if (ch === '\r' && mode !== 'double') {
      return ask('A carriage return outside double quotes is read differently by two parsers.', true)
    }
  }
  return PASS
}

/** 8. Newlines (non-misparsing). Uses the pre-redirection-strip unquoted view. */
function checkNewlines(views: Views): Verdict {
  const view = views.fullyUnquotedPreStrip
  if (!/[\r\n]/.test(view)) return PASS
  // Ask on a line break followed by non-whitespace, except a backslash-newline
  // continuation at a word boundary (a backslash preceded by whitespace).
  const re = /([\s\S])?(\r\n|\r|\n)(\S)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(view)) !== null) {
    const before = m[1] ?? ''
    const beforeBefore = view[m.index - 1] ?? ''
    // A word-boundary continuation: the char before the newline is a backslash
    // preceded by whitespace.
    if (before === '\\' && /\s/.test(beforeBefore)) continue
    return ask('A line break followed by another command needs approval.', false)
  }
  return PASS
}

/** 9. IFS injection. */
function checkIfs(command: string): Verdict {
  return /\$\{?IFS\b|\bIFS=/.test(command)
    ? ask('A reference to the field-separator variable can bypass whitespace-based checks.', false)
    : PASS
}

/** 10. Proc-environ access. */
function checkProcEnviron(command: string): Verdict {
  return /\/proc\/(?:\d+|self)\/environ\b/.test(command)
    ? ask('Reading a process environ file can expose secrets.', false)
    : PASS
}

/** 11. Dangerous patterns (double-quotes-preserved view + substitution table). */
function checkDangerousPatterns(views: Views): Verdict {
  // Unescaped backtick in the double-quotes-preserved view.
  const dq = views.withDoubleQuotes
  for (let i = 0; i < dq.length; i++) {
    if (dq[i] === '\\') {
      i++
      continue
    }
    if (dq[i] === '`') return ask('An unescaped backtick runs a command substitution.', false)
  }
  const command = views.original
  const patterns: Array<[RegExp, string]> = [
    [/<\(/, 'Process substitution can run a hidden command.'],
    [/>\(/, 'Process substitution can run a hidden command.'],
    [/=\(/, 'A zsh process substitution can run a hidden command.'],
    [/(?:^|[\s;&|])=[A-Za-z_]/, 'A zsh equals-expansion resolves a name to a binary path.'],
    [/\$\(/, 'A command substitution can run a hidden command.'],
    [/\$\{/, 'A parameter substitution can expand to an unexpected value.'],
    [/\$\[/, 'Legacy arithmetic expansion can run a hidden expression.'],
    [/\$\+/, 'A zsh parameter expansion can expand unexpectedly.'],
    [/\(#[a-zA-Z]/, 'A zsh glob qualifier can match unexpected files.'],
    [/\*\(#/, 'A zsh glob qualifier can match unexpected files.'],
    [/\balways\s*\{/, 'A zsh always-block runs regardless of failure.'],
    [/<#/, 'PowerShell comment syntax is blocked here as defence in depth.'],
  ]
  for (const [re, message] of patterns) {
    if (re.test(command)) return ask(message, false)
  }
  return PASS
}

/** 12. Redirections (non-misparsing). Input redirection tested first. */
function checkRedirections(views: Views): Verdict {
  const view = views.fullyUnquoted
  if (/</.test(view)) return ask('A command reading from a file needs approval.', false)
  if (/>/.test(view)) return ask('A command writing to a file needs approval.', false)
  return PASS
}

/** 13. Backslash-escaped whitespace outside quotes. */
function checkBackslashWhitespace(command: string): Verdict {
  let mode: 'none' | 'single' | 'double' = 'none'
  for (let i = 0; i < command.length; i++) {
    const ch = command[i] as string
    if (mode !== 'single' && ch === '\\') {
      const next = command[i + 1] ?? ''
      if (mode !== 'double' && (next === ' ' || next === '\t')) {
        return ask('A backslash-escaped space can resolve to a different binary.', false)
      }
      i++
      continue
    }
    if (ch === "'" && mode !== 'double') mode = mode === 'single' ? 'none' : 'single'
    else if (ch === '"' && mode !== 'single') mode = mode === 'double' ? 'none' : 'double'
  }
  return PASS
}

/** 14. Backslash-escaped operators outside double quotes. Odd run fires, even run does not. */
function checkBackslashOperators(command: string): Verdict {
  let mode: 'none' | 'single' | 'double' = 'none'
  for (let i = 0; i < command.length; i++) {
    const ch = command[i] as string
    if (ch === '\\' && mode !== 'double') {
      // Count the backslash run.
      let run = 0
      while (command[i] === '\\') {
        run++
        i++
      }
      const after = command[i] ?? ''
      // An odd run leaves one unpaired backslash immediately before `after`.
      if (run % 2 === 1 && /[;|&<>]/.test(after)) {
        return ask('A backslash-escaped separator can cause a false split downstream.', false)
      }
      // `i` now points at `after`; let the loop re-read it for quote toggles.
      i--
      continue
    }
    if (ch === '\\' && mode === 'double') {
      i++
      continue
    }
    if (ch === "'" && mode !== 'double') mode = mode === 'single' ? 'none' : 'single'
    else if (ch === '"' && mode !== 'single') mode = mode === 'double' ? 'none' : 'double'
  }
  return PASS
}

/** 15. Unicode whitespace. */
const UNICODE_WS_RE = /[\u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000\uFEFF]/
function checkUnicodeWhitespace(command: string): Verdict {
  return UNICODE_WS_RE.test(command)
    ? ask('A Unicode whitespace character is treated differently by two parsers.', false)
    : PASS
}

/** 16. Mid-word hash (quote-characters-preserved view + continuation-joined form). */
function checkMidWordHash(views: Views): Verdict {
  const test = (text: string): boolean => {
    // A `#` preceded by a non-whitespace character, excluding `${#`.
    const re = /(?<!\$\{)(\S)#/g
    let m: RegExpExecArray | null
    while ((m = re.exec(text)) !== null) {
      if ((m[1] as string) === '{' && text[m.index - 1] === '$') continue
      return true
    }
    return false
  }
  const view = views.keepQuoteChars
  const joined = view.replace(/\\+\n/g, seg => (seg.length % 2 === 0 ? seg : ''))
  if (test(view) || test(joined)) {
    return ask('A mid-word hash can hide a command name from allowlist checks.', false)
  }
  return PASS
}

/** 17. Brace expansion (fully unquoted, pre-redirection-strip view). */
function checkBraceExpansion(views: Views): Verdict {
  const view = views.fullyUnquotedPreStrip
  const opens = countUnescaped(view, '{')
  const closes = countUnescaped(view, '}')
  if (opens >= 1 && closes > opens) {
    return ask('An unbalanced brace group can expand at the wrong position.', false)
  }
  if (opens >= 1 && /['"]\{['"]|['"]\}['"]/.test(views.original)) {
    return ask('A quoted brace inside a brace group can craft an unexpected argument.', false)
  }
  // Actual expansion: for each unescaped opener, find its matching closer and
  // scan between them at depth zero for a comma or a two-dot range.
  for (let i = 0; i < view.length; i++) {
    if (view[i] === '{' && !isEscaped(view, i)) {
      const close = matchingBrace(view, i)
      if (close === -1) continue
      let depth = 0
      for (let j = i + 1; j < close; j++) {
        if (view[j] === '{' && !isEscaped(view, j)) depth++
        else if (view[j] === '}' && !isEscaped(view, j)) depth--
        else if (depth === 0 && (view[j] === ',' || (view[j] === '.' && view[j + 1] === '.'))) {
          return ask('A brace expansion can turn one argument into several.', false)
        }
      }
    }
  }
  return PASS
}

/** 18. Zsh-dangerous commands. */
const ZSH_DANGEROUS = new Set([
  'zmodload',
  'emulate',
  'sysopen',
  'sysread',
  'syswrite',
  'sysseek',
  'zpty',
  'ztcp',
  'zsocket',
  'mapfile',
  'zf_rm',
  'zf_mv',
  'zf_ln',
  'zf_chmod',
  'zf_chown',
  'zf_mkdir',
  'zf_rmdir',
  'zf_chgrp',
])
const ZSH_PRECOMMAND = new Set(['command', 'builtin', 'noglob', 'nocorrect'])
function checkZshDangerous(command: string): Verdict {
  const words = command.trim().split(/\s+/)
  let i = 0
  while (i < words.length) {
    const word = words[i] as string
    if (/^[A-Za-z_]\w*=/.test(word) || ZSH_PRECOMMAND.has(word)) {
      i++
      continue
    }
    break
  }
  const base = words[i] ?? ''
  if (ZSH_DANGEROUS.has(base)) {
    return ask(`The zsh builtin \`${base}\` can bypass binary checks.`, false)
  }
  // fc with an editor flag is an eval over history.
  if (base === 'fc' && /\s-\S*e/.test(command)) {
    return ask('The zsh `fc` editor form is effectively an eval over command history.', false)
  }
  return PASS
}

/** 19. Malformed token injection (last). */
function checkMalformedTokens(command: string): Verdict {
  const parse = tryParseShellCommand(command)
  if (!parse.success) return PASS // handled by the caller
  // Only when a command separator is present.
  if (!/;|&&|\|\|/.test(command)) return PASS
  if (hasMalformedTokens(command, parse.tokens)) {
    return ask('Ambiguous token syntax combined with a command separator can run unintended code.', false)
  }
  return PASS
}

// ── brace helpers ───────────────────────────────────────────────────────────

function isEscaped(text: string, index: number): boolean {
  let backslashes = 0
  let j = index - 1
  while (j >= 0 && text[j] === '\\') {
    backslashes++
    j--
  }
  return backslashes % 2 === 1
}

function countUnescaped(text: string, char: string): number {
  let count = 0
  for (let i = 0; i < text.length; i++) {
    if (text[i] === char && !isEscaped(text, i)) count++
  }
  return count
}

function matchingBrace(text: string, openIndex: number): number {
  let depth = 0
  for (let i = openIndex; i < text.length; i++) {
    if (text[i] === '{' && !isEscaped(text, i)) depth++
    else if (text[i] === '}' && !isEscaped(text, i)) {
      depth--
      if (depth === 0) return i
    }
  }
  return -1
}

// ── the battery ─────────────────────────────────────────────────────────────

/** The main validators, in the exact pinned order. `true` = non-misparsing. */
type MainValidator = { run: (views: Views) => Verdict; nonMisparsing: boolean }

function mainValidators(): MainValidator[] {
  return [
    { run: checkJq, nonMisparsing: true },
    { run: checkObfuscatedFlags, nonMisparsing: true },
    { run: checkShellMetacharsInArgs, nonMisparsing: true },
    { run: checkDangerousVariables, nonMisparsing: true },
    { run: v => checkCommentDesync(v.original), nonMisparsing: true },
    { run: v => checkQuotedNewlineBeforeHash(v.original), nonMisparsing: true },
    { run: v => checkCarriageReturn(v.original), nonMisparsing: false },
    { run: checkNewlines, nonMisparsing: false }, // #8 non-misparsing
    { run: v => checkIfs(v.original), nonMisparsing: true },
    { run: v => checkProcEnviron(v.original), nonMisparsing: true },
    { run: checkDangerousPatterns, nonMisparsing: true },
    { run: checkRedirections, nonMisparsing: false }, // #12 non-misparsing
    { run: v => checkBackslashWhitespace(v.original), nonMisparsing: true },
    { run: v => checkBackslashOperators(v.original), nonMisparsing: true },
    { run: v => checkUnicodeWhitespace(v.original), nonMisparsing: true },
    { run: checkMidWordHash, nonMisparsing: true },
    { run: checkBraceExpansion, nonMisparsing: true },
    { run: v => checkZshDangerous(v.original), nonMisparsing: true },
    { run: v => checkMalformedTokens(v.original), nonMisparsing: true },
  ]
}

// The table's non-misparsing entries are newlines (#8) and redirections (#12).
// Their `ask` does not carry the flag; the two flags above are set the other
// way for the loop, so fix them explicitly here.
const NON_MISPARSING_INDICES = new Set([7, 11]) // 0-based: newlines, redirections

/**
 * Run the pre-gates, early validators and the main battery. `analysis`-aware
 * behaviour (the async entry) is layered on top by the async wrapper.
 */
function runBattery(command: string, quoteSource: string): Verdict {
  // Pre-gates (both misparsing).
  if (CONTROL_CHAR_RE.test(command)) {
    return ask('The command contains a control character that two parsers read differently.', true)
  }
  if (hasShellQuoteSingleQuoteBug(command)) {
    return ask('The command triggers a known single-quote tokeniser defect.', true)
  }

  const views = buildViews(command, quoteSource)

  // Early validators.
  const empty = checkEmpty(views)
  if (empty.kind !== 'pass') return empty
  const fragment = checkIncompleteFragment(command)
  if (fragment.kind !== 'pass') return fragment
  if (isSafeHeredocSubstitution(command)) return allow('Safe heredoc substitution.')
  const gitCommit = checkSafeGitCommit(views)
  if (gitCommit.kind !== 'pass') return gitCommit

  // Main validators with the deferred-non-misparsing-ask discipline.
  const validators = mainValidators()
  let deferred: Verdict | null = null
  for (let i = 0; i < validators.length; i++) {
    const verdict = validators[i]!.run(views)
    if (verdict.kind !== 'ask') continue
    const nonMisparsing = NON_MISPARSING_INDICES.has(i)
    const flagged = { ...verdict, misparsing: !nonMisparsing }
    if (nonMisparsing) {
      // Defer the first non-misparsing ask; a later misparsing ask wins.
      if (deferred === null) deferred = flagged
      continue
    }
    return flagged
  }
  if (deferred !== null) return deferred
  return PASS
}

// ── exported entry points ───────────────────────────────────────────────────

/**
 * The synchronous battery. Returns passthrough for "no concern", an early
 * allow normalised to passthrough, or a (possibly misparsing-flagged) ask.
 */
export function bashCommandIsSafe_DEPRECATED(command: string): PermissionResult {
  return toResult(runBattery(command, heredocProcessedForQuotes(command)))
}

/**
 * The asynchronous battery. With no structured analysis available (this build)
 * it delegates to the sync path wholesale. The optional divergence callback is
 * the only consumer of the tokeniser/parser quote-context comparison signal;
 * with no callback the comparison does nothing — reproduced as the empty arm.
 */
export async function bashCommandIsSafeAsync_DEPRECATED(
  command: string,
  onDivergence?: () => void,
): Promise<PermissionResult> {
  // No analysis available in this build: the comparison arm has no observable
  // effect unless a callback was supplied. Keep the comparison and the callback.
  void onDivergence
  return bashCommandIsSafe_DEPRECATED(command)
}
