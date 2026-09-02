/**
 * The permission decision engine for Bash.
 *
 * Every Bash command routes through here. The pipeline combines user rules
 * (allow / ask / deny), path and sandbox policy, permission mode, a read-only
 * allowlist, and the legacy security battery, and always resolves to one of
 * four behaviours — allow, ask, deny, or passthrough (no rule matched; prompt
 * the user). The ordering below is load-bearing: several steps exist only to
 * stop a `deny` from silently degrading into an `ask`. The posture is
 * fail-safe — an unprovable command is asked, never allowed.
 *
 * In this build the structured-parse and classifier lanes are folded out, so
 * the legacy tokeniser + regex battery is the real floor. The AST and
 * classifier branches are still implemented (they are the specified contract
 * and run when those lanes are enabled) but never assume they execute.
 */
import type { ToolPermissionContext } from '../../Tool.js'
import type {
  PermissionResult,
  PermissionDecisionReason,
} from '../../utils/permissions/PermissionResult.js'
import type { PendingClassifierCheck } from '../../types/permissions.js'
import { getCwd } from '../../utils/cwd.js'
import { getPlatform } from '../../utils/platform.js'
import { windowsPathToPosixPath } from '../../utils/windowsPaths.js'
import { modeBypassesPermissions } from '../../utils/permissions/PermissionMode.js'
import { createPermissionRequestMessage } from '../../utils/permissions/decision/requestMessage.js'
import { getRuleByContentsForToolName } from '../../utils/permissions/decision/rules.js'
import {
  parsePermissionRule,
  matchWildcardPattern,
  permissionRuleExtractPrefix,
  suggestionForExactCommand,
  suggestionForPrefix,
  type ShellPermissionRule,
} from '../../utils/permissions/shellRuleMatching.js'
import {
  isClassifierPermissionsEnabled,
  getBashPromptDenyDescriptions,
  getBashPromptAskDescriptions,
  classifyBashCommand,
} from '../../utils/permissions/bashClassifier.js'
import {
  parseForSecurity,
  PARSE_ABORTED,
  pinnedCommandAnalysis,
  type Node,
  type SimpleCommand,
  type Redirect,
} from '../../utils/permissions/decision/commandAnalysis.js'
import {
  bashCommandIsSafe_DEPRECATED,
  bashCommandIsSafeAsync_DEPRECATED,
  stripSafeHeredocSubstitutions,
} from './bashSecurity.js'
import {
  checkCommandOperatorPermissions,
  CD_GIT_BARE_REPO_REASON,
  MULTIPLE_CD_REASON,
  type CommandIdentityCheckers,
} from './bashCommandHelpers.js'
import { checkPermissionMode } from './modeValidation.js'
import { checkPathConstraints } from './pathValidation.js'
import { checkReadOnlyConstraints } from './readOnlyValidation.js'
import { checkSedConstraints } from './sedValidation.js'
import { SandboxManager } from '../../utils/sandbox/sandbox-adapter.js'
import { shouldUseSandbox } from './shouldUseSandbox.js'
import { isAbortError } from '../../utils/errors.js'

// Re-exports of the shared shell-rule grammar so callers do not reach across.
export { matchWildcardPattern, permissionRuleExtractPrefix }
export const bashPermissionRule = (ruleContent: string): ShellPermissionRule =>
  parsePermissionRule(ruleContent)

/** The tool name in permission rules. Contract data. */
const TOOL_NAME = 'Bash'

/** The legacy split's fan-out cap: past this many subcommands, ask. */
export const MAX_SUBCOMMANDS_FOR_SECURITY_CHECK = 50
/** The cap on rules a single compound prompt may propose. */
export const MAX_SUGGESTED_RULES_FOR_COMPOUND = 5

/** The Bash input shape this engine reads. */
type BashInput = {
  command: string
  timeout?: number
  description?: string
  dangerouslyDisableSandbox?: boolean
  _simulatedSedEdit?: unknown
}

// ── comment / wrapper / env stripping ──────────────────────────────────

/** Remove full-line comments; return the original when every line would go. */
function stripComments(command: string): string {
  const lines = command.split('\n')
  const kept = lines.filter(line => {
    const trimmed = line.trim()
    return trimmed !== '' && !trimmed.startsWith('#')
  })
  return kept.length === 0 ? command : kept.join('\n')
}

/** The safe environment-variable allowlist (contract data). */
const SAFE_ENV_VARS = new Set([
  'GOEXPERIMENT', 'GOOS', 'GOARCH', 'CGO_ENABLED', 'GO111MODULE', 'RUST_BACKTRACE',
  'RUST_LOG', 'NODE_ENV', 'PYTHONUNBUFFERED', 'PYTHONDONTWRITEBYTECODE',
  'PYTEST_DISABLE_PLUGIN_AUTOLOAD', 'PYTEST_DEBUG', 'ANTHROPIC_API_KEY', 'LANG',
  'LANGUAGE', 'LC_ALL', 'LC_CTYPE', 'LC_TIME', 'CHARSET', 'TERM', 'COLORTERM',
  'NO_COLOR', 'FORCE_COLOR', 'TZ', 'LS_COLORS', 'LSCOLORS', 'GREP_COLOR',
  'GREP_COLORS', 'GCC_COLORS', 'TIME_STYLE', 'BLOCK_SIZE', 'BLOCKSIZE',
])
// STANDING PROHIBITION — these must NEVER join SAFE_ENV_VARS: PATH, LD_PRELOAD,
// LD_LIBRARY_PATH, any DYLD_*, PYTHONPATH, NODE_PATH, CLASSPATH, RUBYLIB,
// GOFLAGS, RUSTFLAGS, NODE_OPTIONS, HOME, TMPDIR, SHELL, BASH_ENV. They load
// libraries or modules, inject flags, or alter system behaviour.

/** Value characters a safe-list assignment may carry (unquoted). */
const SAFE_ASSIGN_VALUE = String.raw`[A-Za-z0-9_./:@%+,=-]*`

/** The blocklist the sandbox-use policy passes to the aggressive stripper (contract data). */
export const BINARY_HIJACK_VARS: RegExp = /^(?:LD_|DYLD_|PATH$)/

/** The wrapper commands stripped before allow-rule matching (contract data). */
const WRAPPER_COMMANDS = ['timeout', 'time', 'nice', 'stdbuf', 'nohup']

/**
 * Strip safe wrappers and leading safe-list assignments to a fixed point. Two
 * phases, each first removing full-line comments: phase 1 removes leading
 * safe-list env assignments (stopping at the first non-safe one); phase 2
 * removes wrapper commands (never assignments after a wrapper).
 */
export function stripSafeWrappers(command: string): string {
  let previous: string
  let current = command
  do {
    previous = current
    current = stripComments(current)
    current = stripLeadingSafeEnvVars(current)
    current = stripLeadingWrapper(current)
  } while (current !== previous)
  return current.trim()
}

/** Phase 1: remove one leading safe-list assignment; stop at a non-safe one. */
function stripLeadingSafeEnvVars(command: string): string {
  const match = command.match(new RegExp(`^([A-Za-z_]\\w*)=(${SAFE_ASSIGN_VALUE})[ \\t]+`))
  if (!match) return command
  if (!SAFE_ENV_VARS.has(match[1] as string)) return command
  return command.slice(match[0].length)
}

/** Phase 2: remove one leading wrapper command with its flags and options marker. */
function stripLeadingWrapper(command: string): string {
  const word = command.match(/^(\S+)/)?.[1]
  if (!word || !WRAPPER_COMMANDS.includes(word)) return command
  let rest = command.slice(word.length).replace(/^[ \t]+/, '')
  if (word === 'timeout') {
    rest = stripTimeoutFlags(rest)
    // Its `--` marker comes after the flags but before the duration token.
    rest = rest.replace(/^--[ \t]+/, '')
    // A duration token (integer/decimal, optional s/m/h/d) must follow.
    rest = rest.replace(/^\d+(?:\.\d+)?[smhd]?[ \t]+/, '')
    return rest
  }
  if (word === 'nice') {
    // bare, or `-n N` (N may be negative), or legacy `-N`.
    rest = rest.replace(/^-n[ \t]+-?\d+[ \t]+/, '').replace(/^-\d+[ \t]+/, '')
  }
  if (word === 'stdbuf') {
    // One or more fused short flags — [ioe] with L / N / digits — separated
    // by horizontal whitespace, ALL of them stripped. The wrapper is only
    // recognised when at least one such flag is present: a flagless
    // `stdbuf -- rm` is left unchanged, so an allow rule cannot match a
    // non-stdbuf-shaped command.
    const flags = rest.match(/^(?:-[ioe](?:L|N|\d+)(?:[ \t]+|$))+/)
    if (!flags) return command
    rest = rest.slice(flags[0].length)
  }
  // Every wrapper consumes its own optional `--` marker before the command.
  rest = rest.replace(/^--[ \t]+/, '')
  return rest
}

/** Strip GNU timeout flags with the security-critical restricted value class. */
function stripTimeoutFlags(rest: string): string {
  let out = rest
  const noValueLong = /^(?:--foreground|--preserve-status|--verbose)[ \t]+/
  const valueLong = /^(?:--kill-after|--signal)(?:=|[ \t]+)[A-Za-z0-9_.+-]+[ \t]+/
  const shortNoValue = /^-v[ \t]+/
  // The two real short spellings: fused (`-k5`) and separated (`-k 5`). An
  // `=`-fused short form is not a timeout spelling and is not accepted. The
  // value class stays restricted — a permissive class re-opens the
  // command-substitution-in-flag-value bypass.
  const shortValue = /^-[ks](?:[ \t]+)?[A-Za-z0-9_.+-]+[ \t]+/
  let changed = true
  while (changed) {
    changed = false
    for (const re of [noValueLong, valueLong, shortNoValue, shortValue]) {
      if (re.test(out)) {
        out = out.replace(re, '')
        changed = true
      }
    }
  }
  return out
}

/**
 * Strip ALL leading assignments regardless of the safe list, so a denied
 * command stays denied under arbitrary variable prefixes. An optional
 * blocklist stops stripping at (and keeps) a matching variable name.
 */
export function stripAllLeadingEnvVars(command: string, blocklist?: RegExp): string {
  let previous: string
  let current = command
  do {
    previous = current
    current = stripComments(current)
    const match = current.match(/^([A-Za-z_]\w*)(?:\[[^\]]*\])?\+?=/)
    if (match) {
      const name = match[1] as string
      if (blocklist && blocklist.test(name)) break
      const consumed = consumeAggressiveAssignment(current)
      if (consumed !== null) current = consumed
    }
  } while (current !== previous)
  return current.trim()
}

/** Consume one aggressive assignment (quoted or unquoted value) at the string start. */
function consumeAggressiveAssignment(command: string): string | null {
  // NAME(+=|=), then a single-quoted, double-quoted (no raw $ or backtick), or
  // unquoted (no shell metacharacters) value, with concatenated segments.
  const head = command.match(/^[A-Za-z_]\w*(?:\[[^\]]*\])?\+?=/)
  if (!head) return null
  let i = head[0].length
  // Value: sequence of adjacent segments.
  const segment = () => {
    if (command[i] === "'") {
      const end = command.indexOf("'", i + 1)
      if (end === -1) return false
      i = end + 1
      return true
    }
    if (command[i] === '"') {
      let j = i + 1
      while (j < command.length && command[j] !== '"') {
        if (command[j] === '$' || command[j] === '`') return false
        if (command[j] === '\\') j++
        j++
      }
      if (command[j] !== '"') return false
      i = j + 1
      return true
    }
    const m = command.slice(i).match(/^[^$`;|&()<>'"\s\\]+/)
    if (!m || m[0].length === 0) return false
    i += m[0].length
    return true
  }
  let advanced = false
  while (i < command.length && !/\s/.test(command[i] as string)) {
    if (!segment()) return advanced ? consumeTrailingWhitespace(command, i) : null
    advanced = true
  }
  return consumeTrailingWhitespace(command, i)
}

function consumeTrailingWhitespace(command: string, i: number): string {
  const ws = command.slice(i).match(/^[ \t]+/)
  return command.slice(i + (ws ? ws[0].length : 0))
}

// ── prefix extraction and identity normalisers ─────────────────────────

/** The bare-shell / wrapper blocklist (contract data). */
const BARE_SHELL_BLOCKLIST = new Set([
  'sh', 'bash', 'zsh', 'fish', 'csh', 'tcsh', 'ksh', 'dash', 'cmd', 'powershell',
  'pwsh', 'env', 'xargs', 'nice', 'stdbuf', 'nohup', 'timeout', 'time', 'sudo',
  'doas', 'pkexec',
])

/** A subcommand-shaped token: lowercase letters/digits, optionally hyphen-joined, letter-initial. */
const SUBCOMMAND_TOKEN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/

/** Two-word prefix, or null. Skips safe assignments; declines on a non-safe one. */
export function getSimpleCommandPrefix(command: string): string | null {
  const tokens = command.trim().split(/\s+/)
  let i = 0
  while (i < tokens.length && /^[A-Za-z_]\w*=/.test(tokens[i] as string)) {
    const name = (tokens[i] as string).split('=')[0] as string
    if (!SAFE_ENV_VARS.has(name)) return null
    i++
  }
  const rest = tokens.slice(i)
  if (rest.length < 2) return null
  if (!SUBCOMMAND_TOKEN.test(rest[1] as string)) return null
  return `${rest[0]} ${rest[1]}`
}

/** One-word prefix (UI fallback), or null. Rejects blocklist names, paths and flags. */
export function getFirstWordPrefix(command: string): string | null {
  const tokens = command.trim().split(/\s+/)
  let i = 0
  while (i < tokens.length && /^[A-Za-z_]\w*=/.test(tokens[i] as string)) {
    const name = (tokens[i] as string).split('=')[0] as string
    if (!SAFE_ENV_VARS.has(name)) return null
    i++
  }
  const word = tokens[i]
  if (!word) return null
  if (BARE_SHELL_BLOCKLIST.has(word)) return null
  if (word.startsWith('-') || word.includes('/')) return null
  if (!SUBCOMMAND_TOKEN.test(word)) return null
  return word
}

/** git identity: fast path for `git`/`git …`, else strip wrappers and tokenise. */
export function isNormalizedGitCommand(command: string): boolean {
  if (command === 'git' || command.startsWith('git ')) return true
  const stripped = stripSafeWrappers(command)
  const parse = pinnedCommandAnalysis.tryParseShellCommand(stripped)
  if (!parse.success) return /\bgit\b/.test(stripped)
  const tokens = parse.tokens.filter(t => typeof t === 'string') as string[]
  if (tokens[0] === 'git') return true
  if (tokens[0] === 'xargs' && tokens.includes('git')) return true
  return false
}

/** directory-change identity: strip wrappers, tokenise; first token cd/pushd/popd. */
export function isNormalizedCdCommand(command: string): boolean {
  const stripped = stripSafeWrappers(command)
  const parse = pinnedCommandAnalysis.tryParseShellCommand(stripped)
  if (!parse.success) return /\b(?:cd|pushd|popd)\b/.test(stripped)
  const tokens = parse.tokens.filter(t => typeof t === 'string') as string[]
  return tokens[0] === 'cd' || tokens[0] === 'pushd' || tokens[0] === 'popd'
}

/** Any directory change anywhere in a compound command. */
export function commandHasAnyCd(command: string): boolean {
  return pinnedCommandAnalysis
    .splitCommand(command)
    .some(sub => isNormalizedCdCommand(sub.trim()))
}

// ── candidate matching ─────────────────────────────────────────────────

/** Build the redirection-stripped form of a command. */
function withoutRedirections(command: string): string {
  return pinnedCommandAnalysis.extractOutputRedirections(command).commandWithoutRedirections
}

/** Generate candidate strings for matching a command against rules. */
function generateCandidates(command: string, mode: 'exact' | 'prefix', behavior: 'allow' | 'deny' | 'ask'): string[] {
  const trimmed = command.trim()
  const redirStripped = withoutRedirections(trimmed)
  const bases = mode === 'exact' ? [trimmed, redirStripped] : [redirStripped]
  const candidates = new Set<string>()
  for (const base of bases) {
    candidates.add(base)
    const wrapperStripped = stripSafeWrappers(base)
    if (wrapperStripped !== base) candidates.add(wrapperStripped)
  }
  if (behavior === 'deny' || behavior === 'ask') {
    // Iterate the aggressive env stripper + wrapper stripper to a fixed point.
    let changed = true
    while (changed) {
      changed = false
      for (const candidate of [...candidates]) {
        for (const derived of [stripAllLeadingEnvVars(candidate), stripSafeWrappers(candidate)]) {
          if (!candidates.has(derived)) {
            candidates.add(derived)
            changed = true
          }
        }
      }
    }
  }
  return [...candidates]
}

/** Does a rule match a candidate under the given mode? */
function ruleMatches(
  rule: ShellPermissionRule,
  candidate: string,
  mode: 'exact' | 'prefix',
  isCompound: boolean,
  skipCompoundGuard: boolean,
): boolean {
  switch (rule.type) {
    case 'exact':
      return candidate === rule.command
    case 'prefix':
      if (mode === 'exact') return candidate === rule.prefix
      if (isCompound && !skipCompoundGuard) return false
      return matchesPrefixRule(candidate, rule.prefix)
    case 'wildcard':
      if (mode === 'exact') return false
      if (isCompound && !skipCompoundGuard) return false
      return matchWildcardPattern(rule.pattern, candidate)
  }
}

/** Prefix-rule matching with the word boundary and the `xargs` accommodation. */
function matchesPrefixRule(candidate: string, prefix: string): boolean {
  if (candidate === prefix) return true
  if (candidate.startsWith(prefix + ' ')) return true
  if (candidate === `xargs ${prefix}`) return true
  if (candidate.startsWith(`xargs ${prefix} `)) return true
  return false
}

/** Whether a candidate re-splits into more than one subcommand. */
function isCompoundCandidate(candidate: string): boolean {
  return pinnedCommandAnalysis.splitCommand(candidate).length > 1
}

/**
 * Match a command against the Bash rules of one behavior. Returns the first
 * matching rule's content, or null.
 */
function matchRules(
  command: string,
  context: ToolPermissionContext,
  behavior: 'allow' | 'deny' | 'ask',
  mode: 'exact' | 'prefix',
  skipCompoundGuard: boolean,
): string | null {
  const rulesByContent = getRuleByContentsForToolName(context, TOOL_NAME, behavior)
  if (rulesByContent.size === 0) return null
  const candidates = generateCandidates(command, mode, behavior)
  const alwaysSkip = behavior === 'deny' || behavior === 'ask' || skipCompoundGuard
  const compoundOf = new Map<string, boolean>()
  for (const candidate of candidates) {
    if (!alwaysSkip) compoundOf.set(candidate, isCompoundCandidate(candidate))
  }
  for (const [ruleContent] of rulesByContent) {
    const parsed = parsePermissionRule(ruleContent)
    for (const candidate of candidates) {
      const isCompound = alwaysSkip ? false : compoundOf.get(candidate) ?? false
      if (ruleMatches(parsed, candidate, mode, isCompound, alwaysSkip)) {
        return ruleContent
      }
    }
  }
  return null
}

/** Build a rule-typed decision reason from a matched rule content + behavior. */
function ruleReason(
  context: ToolPermissionContext,
  ruleContent: string,
  behavior: 'allow' | 'deny' | 'ask',
): PermissionDecisionReason {
  const rule = getRuleByContentsForToolName(context, TOOL_NAME, behavior).get(ruleContent)
  return {
    type: 'rule',
    rule: rule ?? { source: 'localSettings', ruleBehavior: behavior, ruleValue: { toolName: TOOL_NAME, ruleContent } },
  }
}

// ── suggestion selection ───────────────────────────────────────────────

/** Suggest an allow rule for an exact command, in the precedence order. */
function suggestionForCommand(command: string): ReturnType<typeof suggestionForExactCommand> {
  const trimmed = command.trim()
  // 1. Heredoc operator: prefix from the pre-heredoc text.
  const heredocAt = trimmed.search(/<<-?/)
  if (heredocAt > 0) {
    const before = trimmed.slice(0, heredocAt).trim()
    if (before !== '') {
      const twoWord = getSimpleCommandPrefix(before)
      if (twoWord) return suggestionForPrefix(TOOL_NAME, twoWord)
      const firstTwo = firstTwoTokensAfterAssignments(before)
      if (firstTwo) return suggestionForPrefix(TOOL_NAME, firstTwo)
      return []
    }
  }
  // 2. Multi-line → prefix from the first line.
  if (trimmed.includes('\n')) {
    const firstLine = (trimmed.split('\n')[0] as string).trim()
    return suggestionForPrefix(TOOL_NAME, firstLine)
  }
  // 3. Two-word prefix.
  const twoWord = getSimpleCommandPrefix(trimmed)
  if (twoWord) return suggestionForPrefix(TOOL_NAME, twoWord)
  // 4. Exact command.
  return suggestionForExactCommand(TOOL_NAME, trimmed)
}

/** First two tokens after skipping safe assignments, preserving a flag token. */
function firstTwoTokensAfterAssignments(text: string): string | null {
  const tokens = text.trim().split(/\s+/)
  let i = 0
  while (i < tokens.length && /^[A-Za-z_]\w*=/.test(tokens[i] as string)) {
    const name = (tokens[i] as string).split('=')[0] as string
    if (!SAFE_ENV_VARS.has(name)) return null
    i++
  }
  const rest = tokens.slice(i)
  if (rest.length === 0) return null
  return rest.slice(0, 2).join(' ')
}

// ── exact-match / per-subcommand checks ────────────────────────────────

/** The exact-match permission result (used at several points). */
export function bashToolCheckExactMatchPermission(
  input: BashInput,
  context: ToolPermissionContext,
): PermissionResult {
  const command = input.command.trim()
  const deny = matchRules(command, context, 'deny', 'exact', true)
  if (deny !== null) {
    return {
      behavior: 'deny',
      message: `${TOOL_NAME}(${command}) is blocked by a deny rule.`,
      decisionReason: ruleReason(context, deny, 'deny'),
    }
  }
  const ask = matchRules(command, context, 'ask', 'exact', true)
  if (ask !== null) {
    return {
      behavior: 'ask',
      message: createPermissionRequestMessage(TOOL_NAME),
      decisionReason: ruleReason(context, ask, 'ask'),
    }
  }
  const allow = matchRules(command, context, 'allow', 'exact', false)
  if (allow !== null) {
    return { behavior: 'allow', updatedInput: input, decisionReason: ruleReason(context, allow, 'allow') }
  }
  return {
    behavior: 'passthrough',
    message: `${TOOL_NAME}(${command}) requires approval.`,
    suggestions: suggestionForExactCommand(TOOL_NAME, command),
  }
}

/** The per-subcommand permission decision. */
export function bashToolCheckPermission(
  input: BashInput,
  context: ToolPermissionContext,
  compoundHasCd = false,
  astCommand?: SimpleCommand,
): PermissionResult {
  const exact = bashToolCheckExactMatchPermission(input, context)
  if (exact.behavior === 'deny' || exact.behavior === 'ask') return exact

  const command = input.command.trim()
  // An AST subcommand is already atomic, so skip the compound re-check.
  const skipCompoundGuard = astCommand !== undefined
  const deny = matchRules(command, context, 'deny', 'prefix', true)
  if (deny !== null) {
    return { behavior: 'deny', message: `${TOOL_NAME} deny rule matched.`, decisionReason: ruleReason(context, deny, 'deny') }
  }
  const ask = matchRules(command, context, 'ask', 'prefix', true)
  if (ask !== null) {
    return { behavior: 'ask', message: createPermissionRequestMessage(TOOL_NAME), decisionReason: ruleReason(context, ask, 'ask') }
  }
  // Path constraints (pass AST redirections/commands when present).
  const path = checkPathConstraints(
    input,
    getCwd(),
    context,
    compoundHasCd,
    astCommand?.redirects,
    astCommand ? [astCommand] : undefined,
  )
  if (path.behavior !== 'passthrough') return path
  // Exact allow, then prefix allow.
  if (exact.behavior === 'allow') return exact
  const prefixAllow = matchRules(command, context, 'allow', 'prefix', skipCompoundGuard)
  if (prefixAllow !== null) {
    return { behavior: 'allow', updatedInput: input, decisionReason: ruleReason(context, prefixAllow, 'allow') }
  }
  // Sed constraints BEFORE mode auto-allow.
  const sed = checkSedConstraints(input, context)
  if (sed.behavior !== 'passthrough') return sed
  const mode = checkPermissionMode(input, context)
  if (mode.behavior !== 'passthrough') return mode
  // Read-only allowlist.
  if (isReadOnly(input.command, compoundHasCd)) {
    return { behavior: 'allow', updatedInput: input, decisionReason: { type: 'other', reason: 'Read-only command is allowed' } }
  }
  return { behavior: 'passthrough', message: `${command} requires approval.`, suggestions: suggestionForExactCommand(TOOL_NAME, command) }
}

/** Whether the read-only validator allows the whole command. */
function isReadOnly(command: string, compoundHasCd: boolean): boolean {
  return checkReadOnlyConstraints({ command }, compoundHasCd).behavior === 'allow'
}

/** The check-and-suggest wrapper. */
export async function checkCommandAndSuggestRules(
  input: BashInput,
  context: ToolPermissionContext,
  prefixHint: { commandPrefix: string | null } | null | undefined,
  compoundHasCd = false,
  astParseSucceeded = false,
): Promise<PermissionResult> {
  const exact = bashToolCheckExactMatchPermission(input, context)
  if (exact.behavior !== 'passthrough') return exact
  // Per-subcommand check WITHOUT an AST subcommand (re-parses on this route).
  const check = bashToolCheckPermission(input, context, compoundHasCd)
  if (check.behavior === 'deny' || check.behavior === 'ask') return check
  // Legacy battery over the whole command, unless the AST succeeded / check disabled.
  if (!astParseSucceeded && !isInjectionCheckDisabled()) {
    const legacy = await bashCommandIsSafeAsync_DEPRECATED(input.command)
    if (legacy.behavior !== 'passthrough') {
      const message = legacy.behavior === 'ask' && legacy.message
        ? legacy.message
        : 'The command contains patterns that could pose security risks.'
      return { behavior: 'ask', message, suggestions: [] }
    }
  }
  if (check.behavior === 'allow') return check
  // Replace suggestions with a prefix suggestion when a hint exists.
  const suggestions = prefixHint?.commandPrefix
    ? suggestionForPrefix(TOOL_NAME, prefixHint.commandPrefix)
    : suggestionForExactCommand(TOOL_NAME, input.command)
  return { ...check, suggestions } as PermissionResult
}

// ── sandbox auto-allow ──────────────────────────────────────────────────

function sandboxAutoAllow(command: string, context: ToolPermissionContext): PermissionResult {
  // 1. Full-command deny / ask.
  const fullDeny = matchRules(command, context, 'deny', 'prefix', true)
  if (fullDeny !== null) {
    return { behavior: 'deny', message: `${command} is blocked by a deny rule.`, decisionReason: ruleReason(context, fullDeny, 'deny') }
  }
  const subcommands = pinnedCommandAnalysis.splitCommand(command)
  let stashedAsk: string | null = null
  if (subcommands.length > 1) {
    for (const raw of subcommands) {
      const sub = raw.trim()
      const subDeny = matchRules(sub, context, 'deny', 'prefix', true)
      if (subDeny !== null) {
        // Name the WHOLE command in the denial.
        return { behavior: 'deny', message: `${command} is blocked by a deny rule.`, decisionReason: ruleReason(context, subDeny, 'deny') }
      }
      if (stashedAsk === null) {
        const subAsk = matchRules(sub, context, 'ask', 'prefix', true)
        if (subAsk !== null) stashedAsk = subAsk
      }
    }
  }
  const fullAsk = matchRules(command, context, 'ask', 'prefix', true)
  if (stashedAsk !== null) {
    return { behavior: 'ask', message: createPermissionRequestMessage(TOOL_NAME), decisionReason: ruleReason(context, stashedAsk, 'ask') }
  }
  if (fullAsk !== null) {
    return { behavior: 'ask', message: createPermissionRequestMessage(TOOL_NAME), decisionReason: ruleReason(context, fullAsk, 'ask') }
  }
  return { behavior: 'allow', updatedInput: { command } as BashInput, decisionReason: { type: 'other', reason: 'Auto-allowed with sandbox' } }
}

// ── top-level entry ─────────────────────────────────────────────────────

/** The default remote prefix-extraction function (skipped by default). Its
 *  result carries the whole-command prefix and a per-subcommand prefix map. */
type PrefixFn = (
  command: string,
  signal: AbortSignal,
  isNonInteractiveSession: boolean,
) => Promise<
  | { commandPrefix: string | null; subcommandPrefixes?: Map<string, { commandPrefix: string | null }> }
  | null
>

/** Always false: no escape hatch exists — the injection check always runs. */
function isInjectionCheckDisabled(): boolean {
  return false
}

/** Filter `cd <cwd>` subcommands (any position), keeping the parsed array aligned. */
function filterCwdSubcommands(
  subcommands: string[],
  parsed: (SimpleCommand | undefined)[],
): { subcommands: string[]; parsed: (SimpleCommand | undefined)[] } {
  const cwd = getCwd()
  const posixCwd = getPlatform() === 'windows' ? windowsPathToPosixPath(cwd) : cwd
  const outSub: string[] = []
  const outParsed: (SimpleCommand | undefined)[] = []
  subcommands.forEach((sub, i) => {
    if (sub === `cd ${cwd}` || sub === `cd ${posixCwd}`) return
    outSub.push(sub)
    outParsed.push(parsed[i])
  })
  return { subcommands: outSub, parsed: outParsed }
}

/** The command-identity checkers passed to the operator handler. */
const identityCheckers: CommandIdentityCheckers = {
  isGitCommand: isNormalizedGitCommand,
  isDirectoryChange: isNormalizedCdCommand,
}

/**
 * The main permission entry. Produces a permission result for a Bash command.
 * `prefixFn` defaults to the shared remote extractor (skipped by default);
 * passing a custom function re-enables the remote prefix call.
 */
export async function bashToolHasPermission(
  input: BashInput,
  context: ToolPermissionContext,
  prefixFn: PrefixFn = pinnedCommandAnalysis.getCommandSubcommandPrefix,
): Promise<PermissionResult> {
  const command = input.command
  const compoundHasCd = commandHasAnyCd(command)
  const customPrefixFn = prefixFn !== pinnedCommandAnalysis.getCommandSubcommandPrefix

  // 1. Security parse.
  let astRoot: Node | undefined | typeof PARSE_ABORTED
  let astCommands: SimpleCommand[] | null = null
  let astAvailable = false
  if (!isInjectionCheckDisabled()) {
    const parsed = await parseForSecurity(command)
    if (parsed.kind === 'too-complex') {
      const early = earlyExitDenyCheck(input, context)
      if (early) return early
      return { behavior: 'ask', message: parsed.reason }
    }
    if (parsed.kind === 'simple') {
      const semantic = pinnedCommandAnalysis.checkSemantics(parsed.commands)
      if (!semantic.ok) {
        const early = earlyExitDenyCheck(input, context) ?? semanticsDenyCheck(input, context, parsed.commands)
        if (early) return early
        return { behavior: 'ask', message: semantic.reason }
      }
      astAvailable = true
      astCommands = parsed.commands
    } else {
      // parse-unavailable → legacy tokeniser pre-check.
      const pre = pinnedCommandAnalysis.tryParseShellCommand(command)
      if (!pre.success) {
        return { behavior: 'ask', message: `The command has malformed syntax that cannot be parsed: ${pre.error}` }
      }
    }
  }

  // 2. Sandbox auto-allow.
  if (
    SandboxManager.isSandboxingEnabled() &&
    SandboxManager.isAutoAllowBashIfSandboxedEnabled() &&
    shouldUseSandbox(input)
  ) {
    const auto = sandboxAutoAllow(command, context)
    if (auto.behavior !== 'passthrough') return auto
  }

  // 3. Exact-match check — return only on deny.
  const exact = bashToolCheckExactMatchPermission(input, context)
  if (exact.behavior === 'deny') return exact

  // 4. Prompt-rule classifiers (disabled in this build).
  if (isClassifierPermissionsEnabled()) {
    const denyDescriptions = getBashPromptDenyDescriptions(context)
    const askDescriptions = getBashPromptAskDescriptions(context)
    if (denyDescriptions.length > 0 || askDescriptions.length > 0) {
      const signal = pickSignal(context)
      const [denyResult, askResult] = await Promise.all([
        denyDescriptions.length > 0
          ? classifyBashCommand(command, getCwd(), denyDescriptions, 'deny', signal, false)
          : Promise.resolve(null),
        askDescriptions.length > 0
          ? classifyBashCommand(command, getCwd(), askDescriptions, 'ask', signal, false)
          : Promise.resolve(null),
      ])
      if (signal.aborted) throwAbort()
      if (denyResult?.matches && denyResult.confidence === 'high') {
        return { behavior: 'deny', message: `Blocked by a natural-language deny rule: ${denyResult.matchedDescription ?? ''}`, decisionReason: { type: 'classifier', classifier: 'deny', reason: denyResult.reason } }
      }
      if (askResult?.matches && askResult.confidence === 'high') {
        return { behavior: 'ask', message: `Requires approval: ${askResult.matchedDescription ?? ''}`, decisionReason: { type: 'classifier', classifier: 'ask', reason: askResult.reason }, suggestions: suggestionForExactCommand(TOOL_NAME, command) }
      }
    }
  }

  // 5. Operator handling.
  const operator = await checkCommandOperatorPermissions(
    input,
    segmentInput => bashToolHasPermission(segmentInput, context, prefixFn),
    identityCheckers,
    astRoot,
  )
  if (operator.behavior !== 'passthrough') {
    if (operator.behavior === 'allow') {
      // Re-validate the ORIGINAL command: dangerous-pattern (legacy) when AST
      // was unavailable, then path constraints with the real compound-cd flag.
      if (!astAvailable && !isInjectionCheckDisabled()) {
        const legacy = bashCommandIsSafe_DEPRECATED(command)
        if (legacy.behavior !== 'passthrough' && legacy.behavior !== 'allow') {
          return { behavior: 'ask', message: legacy.message ?? 'This command requires approval.' }
        }
      }
      const path = checkPathConstraints(input, getCwd(), context, compoundHasCd, undefined, astCommands ?? undefined)
      return path.behavior !== 'passthrough' ? path : operator
    }
    return operator
  }

  // 6. Legacy misparsing gate.
  if (!astAvailable && !isInjectionCheckDisabled()) {
    const gate = bashCommandIsSafe_DEPRECATED(command)
    if (gate.behavior === 'ask' && (gate as { isBashSecurityCheckForMisparsing?: boolean }).isBashSecurityCheckForMisparsing) {
      const remainder = stripSafeHeredocSubstitutions(command)
      const rescued = remainder !== null ? bashCommandIsSafe_DEPRECATED(remainder) : gate
      const stillMisparsing =
        rescued.behavior === 'ask' && (rescued as { isBashSecurityCheckForMisparsing?: boolean }).isBashSecurityCheckForMisparsing
      if (remainder === null || stillMisparsing) {
        const exactAllow = matchRules(command.trim(), context, 'allow', 'exact', false)
        if (exactAllow !== null) {
          return { behavior: 'allow', updatedInput: input, decisionReason: ruleReason(context, exactAllow, 'allow') }
        }
        return { behavior: 'ask', message: gate.message ?? 'This command requires approval.' }
      }
    }
  }

  // 7. Subcommand split (prefer AST spans; else legacy split). Filter cd <cwd>.
  const rawSubcommands = astCommands ? astCommands.map(c => c.text) : pinnedCommandAnalysis.splitCommand(command)
  const rawParsed: (SimpleCommand | undefined)[] = astCommands ? astCommands : rawSubcommands.map(() => undefined)
  const filtered = filterCwdSubcommands(rawSubcommands, rawParsed)
  const subcommands = filtered.subcommands
  const parsedSubcommands = filtered.parsed

  // 8. Fan-out cap.
  if (!astAvailable && subcommands.length > MAX_SUBCOMMANDS_FOR_SECURITY_CHECK) {
    const reason = `This command splits into ${subcommands.length} subcommands — too many to safety-check individually.`
    return { behavior: 'ask', message: reason, decisionReason: { type: 'other', reason } }
  }

  // 9. Multiple directory changes.
  if (subcommands.filter(sub => isNormalizedCdCommand(sub)).length > 1) {
    return { behavior: 'ask', message: MULTIPLE_CD_REASON, decisionReason: { type: 'other', reason: MULTIPLE_CD_REASON } }
  }

  // 10. cd + git bare-repository gate.
  if (subcommands.some(isNormalizedCdCommand) && subcommands.some(isNormalizedGitCommand)) {
    return { behavior: 'ask', message: CD_GIT_BARE_REPO_REASON, decisionReason: { type: 'other', reason: CD_GIT_BARE_REPO_REASON } }
  }

  // 11. Per-subcommand decisions (re-read state is the caller's; bare input).
  const decisions = subcommands.map((sub, i) =>
    bashToolCheckPermission({ command: sub }, context, compoundHasCd, parsedSubcommands[i]),
  )

  // 12. Deny wins.
  const denied = decisions.find(d => d.behavior === 'deny')
  if (denied) {
    return { behavior: 'deny', message: 'A subcommand was denied.', decisionReason: subcommandResultsReason(subcommands, decisions) }
  }

  // 13. Original-command path constraints.
  const originalPath = checkPathConstraints(
    input,
    getCwd(),
    context,
    compoundHasCd,
    astCommands ? astCommands.flatMap(c => c.redirects) : undefined,
    astCommands ?? undefined,
  )
  if (originalPath.behavior === 'deny') return originalPath

  // 14. Path-constraint ask, guarded.
  const anySubcommandAsked = decisions.some(d => d.behavior === 'ask')
  if (originalPath.behavior === 'ask' && !anySubcommandAsked) return originalPath

  // 15. Single-ask short-circuit.
  const nonAllow = decisions.filter(d => d.behavior !== 'allow')
  if (nonAllow.length === 1 && (nonAllow[0] as PermissionResult).behavior === 'ask') {
    return nonAllow[0] as PermissionResult
  }

  // 16. Exact allow.
  if (exact.behavior === 'allow') return exact

  // 17. All-allow with injection re-check.
  if (!astAvailable && !isInjectionCheckDisabled()) {
    let possibleInjection = false
    const batteries = await Promise.all(subcommands.map(sub => bashCommandIsSafeAsync_DEPRECATED(sub)))
    possibleInjection = batteries.some(b => b.behavior !== 'passthrough')
    if (decisions.every(d => d.behavior === 'allow') && !possibleInjection) {
      return { behavior: 'allow', updatedInput: input, decisionReason: subcommandResultsReason(subcommands, decisions) }
    }
  } else if (decisions.every(d => d.behavior === 'allow')) {
    return { behavior: 'allow', updatedInput: input, decisionReason: subcommandResultsReason(subcommands, decisions) }
  }

  // 18. Prefix suggestion source (remote call skipped by default). The result
  // carries the whole-command prefix plus a per-subcommand prefix map.
  let prefixHint:
    | { commandPrefix: string | null; subcommandPrefixes?: Map<string, { commandPrefix: string | null }> }
    | null = null
  if (customPrefixFn) {
    const signal = pickSignal(context)
    prefixHint = await prefixFn(command, signal, false)
    if (signal.aborted) throwAbort()
  }

  // 19. Single-subcommand path.
  if (subcommands.length === 1) {
    const single = await checkCommandAndSuggestRules(
      { command: subcommands[0] as string },
      context,
      prefixHint,
      compoundHasCd,
      astAvailable,
    )
    return maybeAttachPendingCheck(single, command, context)
  }

  // 20. Multi-subcommand merge: check-and-suggest runs on EACH subcommand
  // (the rest of the input carried through so fields like the sandbox
  // override survive), with that subcommand's OWN prefix hint from the
  // per-subcommand map — never the whole command or a single shared hint.
  const merged = await Promise.all(
    subcommands.map(sub =>
      checkCommandAndSuggestRules(
        { ...input, command: sub },
        context,
        prefixHint?.subcommandPrefixes?.get(sub) ?? null,
        compoundHasCd,
        astAvailable,
      ),
    ),
  )
  if (merged.every(r => r.behavior === 'allow')) {
    return { behavior: 'allow', updatedInput: input, decisionReason: subcommandResultsReason(subcommands, merged) }
  }
  const collected: ReturnType<typeof suggestionForExactCommand> = []
  const seen = new Set<string>()
  subcommands.forEach((sub, i) => {
    const result = merged[i] as PermissionResult
    if (result.behavior === 'allow') return
    let rules = ('suggestions' in result && result.suggestions) || []
    // Synthesised fallback: a security ask with no rules and a non-rule reason.
    if (result.behavior === 'ask' && rules.length === 0 && result.decisionReason?.type !== 'rule') {
      rules = suggestionForExactCommand(TOOL_NAME, sub)
    }
    for (const rule of rules) {
      const key = JSON.stringify(rule)
      if (!seen.has(key) && collected.length < MAX_SUGGESTED_RULES_FOR_COMPOUND) {
        seen.add(key)
        collected.push(rule)
      }
    }
  })
  const reason = subcommandResultsReason(subcommands, decisions)
  // "Asked" is chosen from the STEP 11 decision array, not the merge results.
  const behavior = anySubcommandAsked ? 'ask' : 'passthrough'
  return {
    behavior,
    message: createPermissionRequestMessage(TOOL_NAME, reason),
    decisionReason: reason,
    ...(collected.length > 0 ? { suggestions: collected } : {}),
  } as PermissionResult
}

/** Compose a subcommand-results decision reason keyed by subcommand text. */
function subcommandResultsReason(subcommands: string[], results: PermissionResult[]): PermissionDecisionReason {
  const map = new Map<string, PermissionResult>()
  subcommands.forEach((sub, i) => map.set(sub, results[i] as PermissionResult))
  return { type: 'subcommandResults', reasons: map }
}

/** The early-exit deny check: exact-match (non-passthrough) then full-command deny rules. */
function earlyExitDenyCheck(input: BashInput, context: ToolPermissionContext): PermissionResult | null {
  const exact = bashToolCheckExactMatchPermission(input, context)
  if (exact.behavior !== 'passthrough') return exact
  const deny = matchRules(input.command.trim(), context, 'deny', 'prefix', true)
  if (deny !== null) {
    return { behavior: 'deny', message: `${input.command} is blocked by a deny rule.`, decisionReason: ruleReason(context, deny, 'deny') }
  }
  return null
}

/** The semantics deny check: the early-exit deny check, then each parsed subcommand's span against prefix deny rules. */
function semanticsDenyCheck(input: BashInput, context: ToolPermissionContext, commands: SimpleCommand[]): PermissionResult | null {
  const early = earlyExitDenyCheck(input, context)
  if (early) return early
  for (const command of commands) {
    const deny = matchRules(command.text.trim(), context, 'deny', 'prefix', true)
    if (deny !== null) {
      return { behavior: 'deny', message: `${command.text} is blocked by a deny rule.`, decisionReason: ruleReason(context, deny, 'deny') }
    }
  }
  return null
}

// ── abort plumbing ──────────────────────────────────────────────────────────

function pickSignal(context: ToolPermissionContext): AbortSignal {
  const anyContext = context as unknown as { abortController?: { signal: AbortSignal } }
  return anyContext.abortController?.signal ?? (new AbortController().signal as unknown as AbortSignal)
}

function throwAbort(): never {
  const error = new Error('The operation was aborted')
  error.name = 'AbortError'
  throw error
}

// ── speculative classifier plumbing (inert while the classifier is off) ───

const speculativeChecks = new Map<string, Promise<PermissionResult | undefined>>()

/**
 * Build a pending classifier check for a command, or undefined when the guards
 * decline. Guards: classifier enabled, not a bypass-posture mode, and at least
 * one allow description.
 */
function buildPendingClassifierCheck(
  command: string,
  toolPermissionContext: ToolPermissionContext,
): PendingClassifierCheck | undefined {
  if (!isClassifierPermissionsEnabled()) return undefined
  if (modeBypassesPermissions(toolPermissionContext.mode)) return undefined
  const descriptions = getBashPromptAskDescriptions(toolPermissionContext)
  if (descriptions.length === 0) return undefined
  return { command, cwd: getCwd(), descriptions }
}

/**
 * Start an allow-classification early so it overlaps pre-tool hooks and dialog
 * setup. Returns whether one was started. Same guards as the pending-check
 * builder.
 */
export function startSpeculativeClassifierCheck(
  command: string,
  toolPermissionContext: ToolPermissionContext,
  signal: AbortSignal,
  isNonInteractiveSession: boolean,
): boolean {
  if (!isClassifierPermissionsEnabled()) return false
  if (modeBypassesPermissions(toolPermissionContext.mode)) return false
  const descriptions = getBashPromptAskDescriptions(toolPermissionContext)
  if (descriptions.length === 0) return false
  const promise = runSpeculativeClassification(command, descriptions, signal, isNonInteractiveSession)
  // A no-op rejection handler so an abort before consumption does not surface;
  // the original (possibly rejecting) promise stays stored for consumers.
  promise.catch(() => {})
  speculativeChecks.set(command, promise)
  return true
}

async function runSpeculativeClassification(
  command: string,
  descriptions: string[],
  signal: AbortSignal,
  isNonInteractiveSession: boolean,
): Promise<PermissionResult | undefined> {
  await classifyBashCommand(command, getCwd(), descriptions, 'allow', signal, isNonInteractiveSession)
  // The high-confidence-allow → decision branch is folded out in this build.
  return undefined
}

/** Read a stored speculative result without removing it. */
export function peekSpeculativeClassifierCheck(command: string): Promise<PermissionResult | undefined> | undefined {
  return speculativeChecks.get(command)
}

/** Read a stored speculative result and remove it. */
export function consumeSpeculativeClassifierCheck(command: string): Promise<PermissionResult | undefined> | undefined {
  const promise = speculativeChecks.get(command)
  speculativeChecks.delete(command)
  return promise
}

/** Drop all speculative checks (session reset, post-compaction). */
export function clearSpeculativeChecks(): void {
  speculativeChecks.clear()
}

/**
 * Run the classifier before a swarm agent escalates a permission. Consumes a
 * speculative result if one exists, else classifies fresh. It has no error
 * handling of its own — a rejection propagates. The high-confidence-allow →
 * decision-reason branch is folded out here, so it always resolves undefined.
 */
export async function awaitClassifierAutoApproval(
  pendingCheck: PendingClassifierCheck,
  signal: AbortSignal,
  isNonInteractiveSession: boolean,
): Promise<PermissionDecisionReason | undefined> {
  const speculative = consumeSpeculativeClassifierCheck(pendingCheck.command)
  if (speculative) {
    await speculative
  } else {
    await classifyBashCommand(pendingCheck.command, pendingCheck.cwd, pendingCheck.descriptions, 'allow', signal, isNonInteractiveSession)
  }
  return undefined
}

/**
 * Run the allow classification while the permission prompt shows, so a
 * high-confidence allow can auto-approve before the user responds. In this
 * build the allow branch is folded down to an on-complete call — "classify,
 * then clear the checking indicator".
 */
export async function executeAsyncClassifierCheck(
  pendingCheck: PendingClassifierCheck,
  signal: AbortSignal,
  isNonInteractiveSession: boolean,
  callbacks: {
    shouldContinue: () => boolean;
    onAllow: (reason: PermissionDecisionReason) => void;
    onComplete?: () => void;
  },
): Promise<void> {
  try {
    await classifyBashCommand(pendingCheck.command, pendingCheck.cwd, pendingCheck.descriptions, 'allow', signal, isNonInteractiveSession)
  } catch (error) {
    if (isAbortError(error) || (error as Error)?.name === 'AbortError') {
      callbacks.onComplete?.()
      return
    }
    callbacks.onComplete?.()
    throw error
  }
  if (!callbacks.shouldContinue()) return // dialog already gone; nothing to clear
  // Allow branch folded to on-complete: onAllow is never invoked in this build.
  void callbacks.onAllow
  callbacks.onComplete?.()
}

/** Attach a pending classifier check to an ask/passthrough single-subcommand result. */
function maybeAttachPendingCheck(result: PermissionResult, command: string, context: ToolPermissionContext): PermissionResult {
  if (result.behavior === 'ask' || result.behavior === 'passthrough') {
    const pending = buildPendingClassifierCheck(command, context)
    if (pending) return { ...result, pendingClassifierCheck: pending }
  }
  return result
}
