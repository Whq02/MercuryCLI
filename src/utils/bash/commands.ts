import type { ControlOperator, ParseEntry } from 'shell-quote'
import {
  createCommandPrefixExtractor,
  createSubcommandPrefixExtractor,
} from '../shell/prefix.js'
import type { CommandPrefixResult, CommandSubcommandPrefixResult } from '../shell/prefix.js'
import { extractHeredocs, restoreHeredocs } from './heredoc.js'
import { quote, tryParseShellCommand } from './shellQuote.js'

export type { CommandPrefixResult, CommandSubcommandPrefixResult } from '../shell/prefix.js'


type Markers = {
  doubleQuote: string
  singleQuote: string
  newline: string
  escapedOpenParen: string
  escapedCloseParen: string
}

function makeMarkers(): Markers {
  const salt = Math.floor(Math.random() * 0x1_0000_0000_0000).toString(16)
  return {
    doubleQuote: `MERCURYdq${salt}z`,
    singleQuote: `MERCURYsq${salt}z`,
    newline: `MERCURYnl${salt}z`,
    escapedOpenParen: `MERCURYop${salt}z`,
    escapedCloseParen: `MERCURYcp${salt}z`,
  }
}

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
        out += '\\'.repeat(run - 1)
        i = j
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

function preserveVariables(key: string): string {
  return `$${key}`
}


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
      if (entry === markers.newline) {
        if (currentString !== null) {
          flush()
        } else {
          currentString = entry
        }
        continue
      }
      currentString = currentString === null ? entry : `${currentString} ${entry}`
      continue
    }

    const op = operatorText(entry)
    if (op === 'glob') {
      const pattern = (entry as { pattern: string }).pattern
      currentString = currentString === null ? pattern : `${currentString} ${pattern}`
      continue
    }
    if ('comment' in entry) {
      flush()
      const commentText = dedupeQuoteMarkers((entry as { comment: string }).comment, markers)
      fragments.push(`#${commentText}`)
      continue
    }
    flush()
    if (op !== null) fragments.push(op)
  }
  flush()

  const restored = fragments.map(fragment => restore(fragment, markers))
  return restoreHeredocs(restored, heredocs)
}

function dedupeQuoteMarkers(text: string, markers: Markers): string {
  return text
    .split(`"${markers.doubleQuote}`)
    .join(markers.doubleQuote)
    .split(`'${markers.singleQuote}`)
    .join(markers.singleQuote)
}

export function filterControlOperators(parts: string[]): string[] {
  return parts.filter(part => !CONTROL_OPERATOR_TOKENS.has(part))
}


const RECOGNISED_DESCRIPTORS: ReadonlySet<string> = new Set(['0', '1', '2'])

function isStaticRedirectTarget(target: string): boolean {
  if (target === '') return false
  if (/[\s'"]/.test(target)) return false
  if (target.startsWith('#') || target.startsWith('!') || target.startsWith('=') || target.startsWith('&')) {
    return false
  }
  if (/[$`*?[{~(<]/.test(target)) return false
  return true
}

export function splitCommand_DEPRECATED(command: string): string[] {
  const parts = splitCommandWithOperators(command)
  const stripped: (string | undefined)[] = []

  for (let i = 0; i < parts.length; i++) {
    const token = parts[i] as string

    if (token === '>&') {
      const next = parts[i + 1]
      if (next !== undefined && RECOGNISED_DESCRIPTORS.has(next)) {
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
      if (a === '&' && parts[i + 2] !== undefined && RECOGNISED_DESCRIPTORS.has(parts[i + 2] as string)) {
        i += 2
        continue
      }
      if (a !== undefined && a.startsWith('&') && RECOGNISED_DESCRIPTORS.has(a.slice(1))) {
        i += 1
        continue
      }
      if (a !== undefined && !CONTROL_OPERATOR_TOKENS.has(a)) {
        let target = a
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
          i += 1
          continue
        }
      }
    }

    stripped.push(token)
  }

  const cleaned = stripped.filter((entry): entry is string => entry !== undefined && entry !== '')
  return filterControlOperators(cleaned)
}


function isPlainCommandList(command: string): boolean {
  const markers = makeMarkers()
  const { processedCommand } = extractHeredocs(command)
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
    return false
  }
  return true
}

function protectQuotesOnly(text: string, markers: Markers): string {
  let out = ''
  for (const ch of text) {
    if (ch === '"') out += `"${markers.doubleQuote}`
    else if (ch === "'") out += `'${markers.singleQuote}`
    else out += ch
  }
  return out
}

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


export type OutputRedirectionCapture = {
  target: string
  operator: '>' | '>>'
}

export type OutputRedirectionResult = {
  commandWithoutRedirections: string
  redirections: OutputRedirectionCapture[]
  hasDangerousRedirection: boolean
}

function hasDangerousExpansion(target: string): boolean {
  if (/[$%`*?[{]/.test(target)) return true
  if (target.startsWith('!') || target.startsWith('=') || target.startsWith('~')) return true
  return false
}

function isHistoryExpansion(rest: string): boolean {
  return (
    rest.startsWith('!') ||
    rest.startsWith('-') ||
    rest.startsWith('?') ||
    /^[0-9]/.test(rest)
  )
}

export function extractOutputRedirections(cmd: string): OutputRedirectionResult {
  const markers = makeMarkers()
  const { processedCommand, heredocs } = extractHeredocs(cmd)
  const joined = joinLineContinuations(processedCommand)

  const parseResult = tryParseShellCommand(protect(joined, markers), preserveVariables)
  if (!parseResult.success) {
    return { commandWithoutRedirections: cmd, redirections: [], hasDangerousRedirection: true }
  }

  const redirections: OutputRedirectionCapture[] = []
  let hasDangerousRedirection = false

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
      while (i < text.length && text[i] !== '\n') i++
      continue
    }
    if (ch !== '>') continue

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

    let j = i
    let append = false
    let combined = false
    j++
    if (text[j] === '>') {
      append = true
      j++
    }
    if (text[j] === '&') {
      combined = true
      j++
    }
    let sawForceMarker = false
    if (text[j] === '|') {
      sawForceMarker = true
      j++
    } else if (text[j] === '!') {
      const rest = text.slice(j + 1)
      if (!isHistoryExpansion(rest)) {
        sawForceMarker = true
        j++
      }
    }
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
        if (k < text.length) k++
        continue
      }
      if (/[\s;|&<>()]/.test(c)) break
      target += c
      k++
    }
    const spanEnd = k

    if (target === '' && !isQuotedTarget) {
      i = j - 1
      continue
    }

    let capturedTarget = restore(target, markers)
    if (
      text[targetStart] === '!' &&
      capturedTarget.startsWith('!') &&
      !isHistoryExpansion(capturedTarget.slice(1))
    ) {
      capturedTarget = capturedTarget.slice(1)
    }

    if (combined && /^[0-9]+$/.test(capturedTarget)) {
      i = spanEnd - 1
      continue
    }

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
    if (fd === null || fd === '1') {
      let ws = spanStart
      while (ws > 0 && (text[ws - 1] === ' ' || text[ws - 1] === '\t')) ws--
      removals.push({ start: ws, end: spanEnd })
    }
    i = spanEnd - 1
    void targetStart
  }

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

function quoteFragmentForReconstruction(fragment: string): string {
  if (/[|&;]/.test(fragment)) {
    return `"${fragment}"`
  }
  if (/[\s]/.test(fragment)) {
    return quote([fragment])
  }
  return fragment
}


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

function helpCommandPreCheck(command: string): CommandPrefixResult | null {
  if (isHelpCommand(command)) {
    return { commandPrefix: command }
  }
  return null
}

const getCommandPrefix = createCommandPrefixExtractor({
  toolName: 'Bash',
  policySpec: BASH_PREFIX_POLICY_SPEC,
  querySource: 'bash_extract_prefix',
  preCheck: helpCommandPreCheck,
})

export const getCommandSubcommandPrefix: ((
  command: string,
  abortSignal: AbortSignal,
  isNonInteractiveSession: boolean,
) => Promise<CommandSubcommandPrefixResult | null>) & {
  cache: { clear?: () => void }
} = createSubcommandPrefixExtractor(getCommandPrefix, splitCommand_DEPRECATED)

export function clearCommandPrefixCaches(): void {
  getCommandPrefix.cache.clear?.()
  getCommandSubcommandPrefix.cache.clear?.()
}
