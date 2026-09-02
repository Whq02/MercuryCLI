import type { PermissionResult } from '../../utils/permissions/PermissionResult.js'
import {
  extractHeredocs,
  hasMalformedTokens,
  hasShellQuoteSingleQuoteBug,
  tryParseShellCommand,
} from '../../utils/permissions/decision/commandAnalysis.js'


type Verdict =
  | { kind: 'pass' }
  | { kind: 'ask'; message: string; misparsing: boolean }
  | { kind: 'allow'; reason: string }

const PASS: Verdict = { kind: 'pass' }
const ask = (message: string, misparsing: boolean): Verdict => ({ kind: 'ask', message, misparsing })
const allow = (reason: string): Verdict => ({ kind: 'allow', reason })

const FLAG_NAME_MESSAGE =
  'A quoted or concatenated flag name can hide a dangerous option from safety checks, so this command needs approval.'

function toResult(verdict: Verdict): PermissionResult {
  switch (verdict.kind) {
    case 'pass':
      return { behavior: 'passthrough', message: 'All security checks passed.' }
    case 'allow':
      return { behavior: 'passthrough', message: verdict.reason }
    case 'ask':
      return {
        behavior: 'ask',
        message: verdict.message,
        isBashSecurityCheckForMisparsing: verdict.misparsing,
      }
  }
}


const CONTROL_CHAR_RE = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/


type Views = {
  original: string
  baseCommand: string
  withDoubleQuotes: string
  fullyUnquoted: string
  fullyUnquotedPreStrip: string
  keepQuoteChars: string
}

function buildViews(original: string, quoteSource: string): Views {
  let withDoubleQuotes = ''
  let fullyUnquotedPreStrip = ''
  let keepQuoteChars = ''
  let mode: 'none' | 'single' | 'double' = 'none'
  const jqMode = /^jq(?:\s|$)/.test(original)

  for (let i = 0; i < quoteSource.length; i++) {
    const ch = quoteSource[i] as string
    if (mode !== 'single' && ch === '\\' && i + 1 < quoteSource.length) {
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
      fullyUnquotedPreStrip += ch
      continue
    }
    if (ch === '"') {
      mode = 'none'
      keepQuoteChars += ch
      if (jqMode) {
        withDoubleQuotes += ch
        fullyUnquotedPreStrip += ch
        keepQuoteChars += ch
      }
      continue
    }
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

function stripSafeRedirections(text: string): string {
  return text
    .replace(/(?<=\s)2\s*>&\s*1(?=\s|$)/g, ' ')
    .replace(/(?<![\d>])[012]?>(?!>)\s*\/dev\/null(?=\s|$)/g, ' ')
    .replace(/<\s*\/dev\/null(?=\s|$)/g, ' ')
}


function heredocProcessedForQuotes(command: string): string {
  try {
    const { processedCommand } = extractHeredocs(command)
    return processedCommand
  } catch {
    return command
  }
}


function checkEmpty(views: Views): Verdict {
  return views.original.trim() === '' ? allow('Empty command.') : PASS
}

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


const HEREDOC_ALLOWED_REMAINDER = /^[A-Za-z0-9 \t'"./\-_@=,:+~]*$/

function isSafeHeredocSubstitution(command: string): boolean {
  const stripped = stripSafeHeredocSubstitutions(command)
  if (stripped === null) return false
  const firstOpen = command.indexOf('$(')
  if (firstOpen === -1) return false
  const before = command.slice(0, firstOpen)
  const remainder = stripped.trim()
  if (remainder !== '') {
    if (before.trim() === '') return false
    if (!HEREDOC_ALLOWED_REMAINDER.test(remainder)) return false
    if (bashCommandIsSafe_DEPRECATED(remainder).behavior === 'ask') return false
  }
  return true
}

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
    const openLineEnd = command.indexOf('\n', opener.lastIndex)
    if (openLineEnd === -1) continue
    const openTail = command.slice(opener.lastIndex, openLineEnd)
    if (openTail.trim() !== '') continue
    const closeParen = findClosingParenAfterDelimiter(command, openLineEnd + 1, delimiter)
    if (closeParen === -1) continue
    regions.push({ start: openStart, end: closeParen + 1 })
    matchedAny = true
    opener.lastIndex = closeParen + 1
  }

  if (!matchedAny) return null
  let result = command
  for (const region of regions.reverse()) {
    result = result.slice(0, region.start) + result.slice(region.end)
  }
  return result
}

function findClosingParenAfterDelimiter(text: string, fromIndex: number, delimiter: string): number {
  const lines = text.slice(fromIndex).split('\n')
  let offset = fromIndex
  for (const line of lines) {
    const trimmedStart = line.replace(/^\t+/, '')
    if (trimmedStart.startsWith(delimiter)) {
      const after = trimmedStart.slice(delimiter.length)
      if (/^[;&|<>]/.test(after.trim())) return -1
      const parenOnLine = text.indexOf(')', offset)
      if (parenOnLine !== -1) return parenOnLine
    }
    offset += line.length + 1
  }
  return -1
}


function checkSafeGitCommit(views: Views): Verdict {
  if (views.baseCommand !== 'git') return PASS
  if (!/^git\s+commit\s/.test(views.original)) return PASS
  if (views.original.includes('\\')) return PASS

  const match = views.original.match(
    /^git[ \t]+commit[ \t]+([^;&|<>()`$\n\r]*?)-m[ \t]+(['"])([\s\S]*?)\2([^\n]*)$/,
  )
  if (!match) return PASS
  const messageContent = match[3] as string
  const remainder = match[4] as string
  const doubleQuoted = match[2] === '"'

  if (doubleQuoted && /\$\(|`|\$\{/.test(messageContent)) {
    return ask('The commit message contains an expansion that would run at commit time.', false)
  }
  if (/[;&|()`]|\$\(|\$\{/.test(remainder)) return PASS
  const remainderUnquoted = remainder.replace(/'[^']*'/g, '').replace(/"[^"]*"/g, '')
  if (/[<>]/.test(remainderUnquoted)) return PASS
  if (messageContent.startsWith('-')) return ask(FLAG_NAME_MESSAGE, false)
  return allow('Simple git commit.')
}


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

function checkObfuscatedFlags(views: Views): Verdict {
  const command = views.original
  if (views.baseCommand === 'echo' && !/[|&;]/.test(command)) return PASS

  if (/\$'/.test(command)) return ask('ANSI-C quoting can encode any character.', false)
  if (/\$"/.test(command)) return ask('Locale quoting can hide a flag.', false)
  if (/\$['"]['"]\s*-/.test(command)) return ask('An empty special-quote pair before a dash can hide a flag.', false)
  if (/(?:^|\s)(?:''|"")+\s*-/.test(command)) return ask('An empty quote pair adjacent to a dash can hide a flag.', false)
  if (/(?:'')+'-|(?:"")+"-/.test(command)) return ask(FLAG_NAME_MESSAGE, false)
  if (/(?:^|\s)(?:'{3,}|"{3,})/.test(command)) return ask('Consecutive quote characters at a word start look like flag obfuscation.', false)

  const scanVerdict = scanForHiddenFlags(command)
  if (scanVerdict.kind !== 'pass') return scanVerdict

  if (/(?:^|\s)['"]-/.test(views.fullyUnquoted) || /['"]['"]-/.test(views.fullyUnquoted)) {
    return ask(FLAG_NAME_MESSAGE, false)
  }
  return PASS
}

function scanForHiddenFlags(command: string): Verdict {
  let mode: 'none' | 'single' | 'double' = 'none'
  for (let i = 0; i < command.length; i++) {
    const ch = command[i] as string
    if (mode !== 'single' && ch === '\\') {
      i++
      continue
    }
    if (mode === 'none') {
      if (i > 0 && /\s/.test(command[i - 1] as string) && (ch === "'" || ch === '"' || ch === '`')) {
        const probe = probeWhitespaceQuote(command, i, ch)
        if (probe.kind !== 'pass') return probe
      }
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

function probeWhitespaceQuote(command: string, openIndex: number, quote: string): Verdict {
  const close = command.indexOf(quote, openIndex + 1)
  if (close === -1) return PASS
  const content = command.slice(openIndex + 1, close)
  const after = command[close + 1] ?? ''
  if (/^-+[A-Za-z0-9$`]/.test(content)) return ask(FLAG_NAME_MESSAGE, false)
  if (/^-+$/.test(content) && /[A-Za-z0-9\\$\{`\-]/.test(after)) return ask(FLAG_NAME_MESSAGE, false)
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

function probeWhitespaceHyphen(command: string, hyphenIndex: number): Verdict {
  let token = ''
  let sawCut = false
  for (let i = hyphenIndex; i < command.length; i++) {
    const ch = command[i] as string
    if (/\s/.test(ch) || ch === '=') break
    if (/\bcut\b/.test(command) && token === '-d' && (ch === "'" || ch === '"' || ch === '`')) {
      sawCut = true
      break
    }
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

function checkShellMetacharsInArgs(views: Views): Verdict {
  const view = views.withDoubleQuotes
  const quotedArg = /(?:^|\s)(['"])([^'"\s]*)\1(?=\s|$)/g
  let m: RegExpExecArray | null
  while ((m = quotedArg.exec(view)) !== null) {
    const content = (m[2] as string).replace(/\\[;&]/g, '')
    if (/[;&]/.test(content)) {
      return ask('A quoted argument contains a shell control character.', false)
    }
  }
  if (/-(?:i?name|path)\s+(['"])[^'"\s]*[;|&][^'"\s]*\1(?=\s|$)/.test(view)) {
    return ask('A find pattern contains a shell control character.', false)
  }
  if (/-regex\s+(['"])[^'"\s]*[;&][^'"\s]*\1(?=\s|$)/.test(view)) {
    return ask('A regex predicate contains a shell control character.', false)
  }
  return PASS
}

function checkDangerousVariables(views: Views): Verdict {
  const view = views.fullyUnquoted
  if (/\$[A-Za-z_]\w*\s*[|<>]|[|<>]\s*\$[A-Za-z_]\w*/.test(view)) {
    return ask('A variable reference next to a redirect or pipe can expand to an unexpected command.', false)
  }
  return PASS
}

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

function checkNewlines(views: Views): Verdict {
  const view = views.fullyUnquotedPreStrip
  if (!/[\r\n]/.test(view)) return PASS
  const re = /([\s\S])?(\r\n|\r|\n)(\S)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(view)) !== null) {
    const before = m[1] ?? ''
    const beforeBefore = view[m.index - 1] ?? ''
    if (before === '\\' && /\s/.test(beforeBefore)) continue
    return ask('A line break followed by another command needs approval.', false)
  }
  return PASS
}

function checkIfs(command: string): Verdict {
  return /\$\{?IFS\b|\bIFS=/.test(command)
    ? ask('A reference to the field-separator variable can bypass whitespace-based checks.', false)
    : PASS
}

function checkProcEnviron(command: string): Verdict {
  return /\/proc\/(?:\d+|self)\/environ\b/.test(command)
    ? ask('Reading a process environ file can expose secrets.', false)
    : PASS
}

function checkDangerousPatterns(views: Views): Verdict {
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

function checkRedirections(views: Views): Verdict {
  const view = views.fullyUnquoted
  if (/</.test(view)) return ask('A command reading from a file needs approval.', false)
  if (/>/.test(view)) return ask('A command writing to a file needs approval.', false)
  return PASS
}

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

function checkBackslashOperators(command: string): Verdict {
  let mode: 'none' | 'single' | 'double' = 'none'
  for (let i = 0; i < command.length; i++) {
    const ch = command[i] as string
    if (ch === '\\' && mode !== 'double') {
      let run = 0
      while (command[i] === '\\') {
        run++
        i++
      }
      const after = command[i] ?? ''
      if (run % 2 === 1 && /[;|&<>]/.test(after)) {
        return ask('A backslash-escaped separator can cause a false split downstream.', false)
      }
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

const UNICODE_WS_RE = /[\u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000\uFEFF]/
function checkUnicodeWhitespace(command: string): Verdict {
  return UNICODE_WS_RE.test(command)
    ? ask('A Unicode whitespace character is treated differently by two parsers.', false)
    : PASS
}

function checkMidWordHash(views: Views): Verdict {
  const test = (text: string): boolean => {
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
  if (base === 'fc' && /\s-\S*e/.test(command)) {
    return ask('The zsh `fc` editor form is effectively an eval over command history.', false)
  }
  return PASS
}

function checkMalformedTokens(command: string): Verdict {
  const parse = tryParseShellCommand(command)
  if (!parse.success) return PASS
  if (!/;|&&|\|\|/.test(command)) return PASS
  if (hasMalformedTokens(command, parse.tokens)) {
    return ask('Ambiguous token syntax combined with a command separator can run unintended code.', false)
  }
  return PASS
}


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
    { run: checkNewlines, nonMisparsing: false },
    { run: v => checkIfs(v.original), nonMisparsing: true },
    { run: v => checkProcEnviron(v.original), nonMisparsing: true },
    { run: checkDangerousPatterns, nonMisparsing: true },
    { run: checkRedirections, nonMisparsing: false },
    { run: v => checkBackslashWhitespace(v.original), nonMisparsing: true },
    { run: v => checkBackslashOperators(v.original), nonMisparsing: true },
    { run: v => checkUnicodeWhitespace(v.original), nonMisparsing: true },
    { run: checkMidWordHash, nonMisparsing: true },
    { run: checkBraceExpansion, nonMisparsing: true },
    { run: v => checkZshDangerous(v.original), nonMisparsing: true },
    { run: v => checkMalformedTokens(v.original), nonMisparsing: true },
  ]
}

const NON_MISPARSING_INDICES = new Set([7, 11])

function runBattery(command: string, quoteSource: string): Verdict {
  if (CONTROL_CHAR_RE.test(command)) {
    return ask('The command contains a control character that two parsers read differently.', true)
  }
  if (hasShellQuoteSingleQuoteBug(command)) {
    return ask('The command triggers a known single-quote tokeniser defect.', true)
  }

  const views = buildViews(command, quoteSource)

  const empty = checkEmpty(views)
  if (empty.kind !== 'pass') return empty
  const fragment = checkIncompleteFragment(command)
  if (fragment.kind !== 'pass') return fragment
  if (isSafeHeredocSubstitution(command)) return allow('Safe heredoc substitution.')
  const gitCommit = checkSafeGitCommit(views)
  if (gitCommit.kind !== 'pass') return gitCommit

  const validators = mainValidators()
  let deferred: Verdict | null = null
  for (let i = 0; i < validators.length; i++) {
    const verdict = validators[i]!.run(views)
    if (verdict.kind !== 'ask') continue
    const nonMisparsing = NON_MISPARSING_INDICES.has(i)
    const flagged = { ...verdict, misparsing: !nonMisparsing }
    if (nonMisparsing) {
      if (deferred === null) deferred = flagged
      continue
    }
    return flagged
  }
  if (deferred !== null) return deferred
  return PASS
}


export function bashCommandIsSafe_DEPRECATED(command: string): PermissionResult {
  return toResult(runBattery(command, heredocProcessedForQuotes(command)))
}

export async function bashCommandIsSafeAsync_DEPRECATED(
  command: string,
  onDivergence?: () => void,
): Promise<PermissionResult> {
  void onDivergence
  return bashCommandIsSafe_DEPRECATED(command)
}
