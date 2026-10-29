import type { ToolPermissionContext } from '../../Tool.js'
import type {
  PermissionResult,
  PermissionDecisionReason,
} from '../../utils/permissions/PermissionResult.js'
import type { PermissionRule } from '../../types/permissions.js'
import { resolveShellCwd } from '../../utils/Shell.js'
import { hiddenCommandCharacterReason } from '../../utils/sanitization.js'
import { credentialUploadReason } from '../../utils/permissions/commandContent.js'
import { refusalWithReason, ruleSentence, withRuleReason } from '../../utils/permissions/ruleReason.js'
import { getPlatform } from '../../utils/platform.js'
import { uncPathRisk, uncPathMessage } from '../../utils/permissions/uncPath.js'
import { windowsPathToPosixPath } from '../../utils/windowsPaths.js'
import { createPermissionRequestMessage } from '../../utils/permissions/decision/requestMessage.js'
import { getRuleByContentsForToolName } from '../../utils/permissions/decision/rules.js'
import {
  knownShellCommandPrefix,
  parsePermissionRule,
  matchWildcardPattern,
  permissionRuleExtractPrefix,
  suggestionForExactCommand,
  suggestionForPrefix,
  type ShellPermissionRule,
} from '../../utils/permissions/shellRuleMatching.js'
import {
  withBashParseScope,
  parseForSecurity,
  preparedCommandRoot,
  extractShellCScript,
  prepareShellCScripts,
  shellCCommands,
  SHELL_C_MAX_DEPTH,
  preparedSecurityParse,
  peelWrappers,
  shellCommandText,
  PARSE_ABORTED,
  pinnedCommandAnalysis,
  splitListSegments,
  WILDCARD_REASON,
  type Node,
  type SimpleCommand,
} from '../../utils/permissions/decision/commandAnalysis.js'
import {
  checkCommandOperatorPermissions,
  CD_GIT_BARE_REPO_REASON,
  MULTIPLE_CD_REASON,
  type CommandIdentityCheckers,
} from './bashCommandHelpers.js'
import { checkPermissionMode } from './modeValidation.js'
import { checkPathConstraints, checkShellCwd } from './pathValidation.js'
import { checkPreparedReadOnlyConstraints, cutPart, notReadOnlyClause, type NotReadOnly } from './readOnlyValidation.js'
import { checkSedConstraints } from './sedValidation.js'
import { shellCredentialWritePath, shellMercurySecretPath, shellSelfProtectionReason } from '../../utils/permissions/shellProtectedPaths.js'
import { gitArgs } from '../../utils/git/spawnArgs.js'

export { matchWildcardPattern, permissionRuleExtractPrefix }

const TOOL_NAME = 'Bash'

const MAX_SUGGESTED_RULES_FOR_COMPOUND = 5

type BashInput = {
  command: string
  cwd?: string
  timeout?: number
  description?: string
  _simulatedSedEdit?: unknown
}


function stripComments(command: string): string {
  const lines = command.split('\n')
  const kept = lines.filter(line => {
    const trimmed = line.trim()
    return trimmed !== '' && !trimmed.startsWith('#')
  })
  return kept.length === 0 ? command : kept.join('\n')
}

const SAFE_ENV_VARS = new Set([
  'GOEXPERIMENT', 'GOOS', 'GOARCH', 'CGO_ENABLED', 'GO111MODULE', 'RUST_BACKTRACE',
  'RUST_LOG', 'NODE_ENV', 'PYTHONUNBUFFERED', 'PYTHONDONTWRITEBYTECODE',
  'PYTEST_DISABLE_PLUGIN_AUTOLOAD', 'PYTEST_DEBUG', 'ANTHROPIC_API_KEY', 'LANG',
  'LANGUAGE', 'LC_ALL', 'LC_CTYPE', 'LC_TIME', 'CHARSET', 'TERM', 'COLORTERM',
  'NO_COLOR', 'FORCE_COLOR', 'TZ', 'LS_COLORS', 'LSCOLORS', 'GREP_COLOR',
  'GREP_COLORS', 'GCC_COLORS', 'TIME_STYLE', 'BLOCK_SIZE', 'BLOCKSIZE',
])

const SAFE_ASSIGN_VALUE = String.raw`[A-Za-z0-9_./:@%+,=-]*`

const WRAPPER_COMMANDS = ['timeout', 'time', 'nice', 'stdbuf', 'nohup']

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

function stripLeadingSafeEnvVars(command: string): string {
  const match = command.match(new RegExp(`^([A-Za-z_]\\w*)=(${SAFE_ASSIGN_VALUE})[ \\t]+`))
  if (!match) return command
  if (!SAFE_ENV_VARS.has(match[1] as string)) return command
  return command.slice(match[0].length)
}

function stripLeadingWrapper(command: string): string {
  const word = command.match(/^(\S+)/)?.[1]
  if (!word || !WRAPPER_COMMANDS.includes(word)) return command
  let rest = command.slice(word.length).replace(/^[ \t]+/, '')
  if (word === 'timeout') {
    rest = stripTimeoutFlags(rest)
    rest = rest.replace(/^--[ \t]+/, '')
    rest = rest.replace(/^\d+(?:\.\d+)?[smhd]?[ \t]+/, '')
    return rest
  }
  if (word === 'nice') {
    rest = rest.replace(/^-n[ \t]+-?\d+[ \t]+/, '').replace(/^-\d+[ \t]+/, '')
  }
  if (word === 'stdbuf') {
    const flags = rest.match(/^(?:-[ioe](?:L|N|\d+)(?:[ \t]+|$))+/)
    if (!flags) return command
    rest = rest.slice(flags[0].length)
  }
  rest = rest.replace(/^--[ \t]+/, '')
  return rest
}

function stripTimeoutFlags(rest: string): string {
  let out = rest
  const noValueLong = /^(?:--foreground|--preserve-status|--verbose)[ \t]+/
  const valueLong = /^(?:--kill-after|--signal)(?:=|[ \t]+)[A-Za-z0-9_.+-]+[ \t]+/
  const shortNoValue = /^-v[ \t]+/
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

function consumeAggressiveAssignment(command: string): string | null {
  const head = command.match(/^[A-Za-z_]\w*(?:\[[^\]]*\])?\+?=/)
  if (!head) return null
  let i = head[0].length
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


function suggestedCommandPrefix(command: string): string | null {
  let current = command.trim()
  for (;;) {
    const next = stripLeadingSafeEnvVars(current)
    if (next === current) return knownShellCommandPrefix(current)
    current = next
  }
}

export function getSimpleCommandPrefix(command: string): string | null {
  const prefix = suggestedCommandPrefix(command)
  return prefix?.includes(' ') ? prefix : null
}

export function getFirstWordPrefix(command: string): string | null {
  const prefix = suggestedCommandPrefix(command)
  return prefix !== null && !prefix.includes(' ') ? prefix : null
}

function normalizedWords(command: string): string[][] {
  const parsed = preparedSecurityParse(command)
  if (parsed.kind !== 'simple') return []
  return shellCCommands(parsed.commands).map(simple => peelWrappers(simple.argv)).filter((argv): argv is string[] => Array.isArray(argv))
}

export function isNormalizedGitCommand(command: string): boolean {
  return normalizedWords(command).some(argv => argv[0] === 'git' || argv[0] === 'xargs' && argv.includes('git'))
}

function isNormalizedCdCommand(command: string): boolean {
  return normalizedWords(command).some(argv => ['cd', 'pushd', 'popd'].includes(argv[0] ?? ''))
}


function withoutRedirections(command: string): string {
  return pinnedCommandAnalysis.extractOutputRedirections(command).commandWithoutRedirections
}

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
    case 'wildcard':
      if (mode === 'exact') return false
      if (isCompound && !skipCompoundGuard) return false
      return matchWildcardPattern(rule.pattern, candidate)
  }
}

function isCompoundCandidate(candidate: string): boolean {
  return pinnedCommandAnalysis.splitCommand(candidate).length > 1
}

function matchRules(
  command: string,
  context: ToolPermissionContext,
  behavior: 'allow' | 'deny' | 'ask',
  mode: 'exact' | 'prefix',
  skipCompoundGuard: boolean,
): string | null {
  return walkRules(command, context, behavior, mode, skipCompoundGuard, false)[0] ?? null
}

function matchAllRules(
  command: string,
  context: ToolPermissionContext,
  behavior: 'allow' | 'deny' | 'ask',
  mode: 'exact' | 'prefix',
  skipCompoundGuard: boolean,
): string[] {
  return walkRules(command, context, behavior, mode, skipCompoundGuard, true)
}

function walkRules(
  command: string,
  context: ToolPermissionContext,
  behavior: 'allow' | 'deny' | 'ask',
  mode: 'exact' | 'prefix',
  skipCompoundGuard: boolean,
  all: boolean,
): string[] {
  const found: string[] = []
  const rulesByContent = getRuleByContentsForToolName(context, TOOL_NAME, behavior)
  if (rulesByContent.size === 0) return found
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
        found.push(ruleContent)
        if (!all) return found
        break
      }
    }
  }
  return found
}

function ruleFor(
  context: ToolPermissionContext,
  ruleContent: string,
  behavior: 'allow' | 'deny' | 'ask',
): PermissionRule {
  const rule = getRuleByContentsForToolName(context, TOOL_NAME, behavior).get(ruleContent)
  return rule ?? { source: 'localSettings', ruleBehavior: behavior, ruleValue: { toolName: TOOL_NAME, ruleContent } }
}

function ruleReason(
  context: ToolPermissionContext,
  ruleContent: string,
  behavior: 'allow' | 'deny' | 'ask',
): PermissionDecisionReason {
  return { type: 'rule', rule: ruleFor(context, ruleContent, behavior) }
}

function denyByRule(
  context: ToolPermissionContext,
  subject: string,
  ruleContent: string,
  matches: () => string[],
): PermissionResult {
  const said = withRuleReason(context, ruleFor(context, ruleContent, 'deny'), () =>
    matches().map(content => ruleFor(context, content, 'deny')),
  )
  return {
    behavior: 'deny',
    message: refusalWithReason(ruleSentence(subject, 'deny', said), said.ruleValue.reason),
    decisionReason: { type: 'rule', rule: said },
  }
}

function askByRule(context: ToolPermissionContext, subject: string, ruleContent: string): PermissionResult {
  const rule = ruleFor(context, ruleContent, 'ask')
  return { behavior: 'ask', message: ruleSentence(subject, 'ask', rule), decisionReason: { type: 'rule', rule } }
}


function suggestionForCommand(command: string): ReturnType<typeof suggestionForExactCommand> {
  const prefix = suggestedCommandPrefix(command)
  return prefix === null ? suggestionForExactCommand(TOOL_NAME, command.trim()) : suggestionForPrefix(TOOL_NAME, prefix)
}


export function bashToolCheckExactMatchPermission(
  input: BashInput,
  context: ToolPermissionContext,
): PermissionResult {
  const command = input.command.trim()
  const deny = matchRules(command, context, 'deny', 'exact', true)
  if (deny !== null) {
    return denyByRule(context, command, deny, () => matchAllRules(command, context, 'deny', 'exact', true))
  }
  const ask = matchRules(command, context, 'ask', 'exact', true)
  if (ask !== null) {
    return askByRule(context, command, ask)
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

export function readBashRuleVerdict(input: BashInput, context: ToolPermissionContext): PermissionResult {
  const command = input.command.trim()
  for (const behavior of ['deny', 'ask', 'allow'] as const) {
    const matched = matchRules(command, context, behavior, 'exact', true) ?? matchRules(command, context, behavior, 'prefix', true)
    if (matched === null) continue
    if (behavior === 'deny') return denyByRule(context, command, matched, () => matchAllRules(command, context, 'deny', 'prefix', true))
    if (behavior === 'ask') return askByRule(context, command, matched)
    return { behavior: 'allow', updatedInput: input, decisionReason: ruleReason(context, matched, 'allow') }
  }
  return { behavior: 'passthrough', message: 'No Bash rule covers this command.' }
}

function approvalSentence(shown: string, reason: NotReadOnly | undefined): string {
  const clause = reason === undefined ? '' : `: ${notReadOnlyClause(reason)}`
  const sentence = `\`${cutPart(shown)}\` requires approval${clause}`
  return /[.!?]$/.test(sentence) ? sentence : `${sentence}.`
}

export function bashToolCheckPermission(
  input: BashInput,
  context: ToolPermissionContext,
  compoundHasCd = false,
  astCommand?: SimpleCommand,
  shown?: string,
): PermissionResult {
  const exact = bashToolCheckExactMatchPermission(input, context)
  if (exact.behavior === 'deny') return exact
  const parsed = astCommand ? { kind: 'simple' as const, commands: [astCommand] } : preparedSecurityParse(input.command)
  if (parsed.kind !== 'simple') return unprovenAsk(parsed.kind === 'too-complex' ? parsed.reason : 'the shell parser has not produced a tree; retry the command, or approve')
  const semantic = pinnedCommandAnalysis.checkSemantics(parsed.commands)
  if (!semantic.ok) return unprovenAsk(semantic.reason)
  if (parsed.commands.length !== 1) return unprovenAsk('this entry needs one parsed command; split the command, or approve')
  astCommand = parsed.commands[0]
  if (exact.behavior === 'ask') return exact

  const command = input.command.trim()
  const skipCompoundGuard = astCommand !== undefined
  const deny = matchRules(command, context, 'deny', 'prefix', true)
  if (deny !== null) {
    return denyByRule(context, command, deny, () => matchAllRules(command, context, 'deny', 'prefix', true))
  }
  const ask = matchRules(command, context, 'ask', 'prefix', true)
  if (ask !== null) {
    return askByRule(context, command, ask)
  }
  const path = checkPathConstraints(
    input,
    resolveShellCwd(input.cwd),
    context,
    compoundHasCd,
    astCommand?.redirects,
    astCommand ? [astCommand] : undefined,
  )
  if (path.behavior !== 'passthrough') return path
  if (exact.behavior === 'allow') return exact
  const prefixAllow = matchRules(command, context, 'allow', 'prefix', skipCompoundGuard)
  if (prefixAllow !== null) {
    return { behavior: 'allow', updatedInput: input, decisionReason: ruleReason(context, prefixAllow, 'allow') }
  }
  const sed = checkSedConstraints(input, context)
  if (sed.behavior !== 'passthrough') return sed
  const mode = checkPermissionMode(input, context)
  if (mode.behavior !== 'passthrough') return mode
  const readOnly = checkPreparedReadOnlyConstraints(input, compoundHasCd, astCommand ? { ...astCommand, redirects: [] } : undefined, SHELL_C_MAX_DEPTH)
  if (readOnly.behavior === 'allow') {
    return { behavior: 'allow', updatedInput: input, decisionReason: { type: 'other', reason: 'Read-only command is allowed' } }
  }
  const reason = approvalSentence(shown ?? command, readOnly.notReadOnly)
  return { behavior: 'passthrough', message: reason, decisionReason: { type: 'other', reason }, suggestions: suggestionForExactCommand(TOOL_NAME, command) }
}

async function checkCommandAndSuggestRules(
  input: BashInput,
  context: ToolPermissionContext,
  prefixHint: { commandPrefix: string | null } | null | undefined,
  compoundHasCd = false,
  shown?: string,
  astCommand?: SimpleCommand,
): Promise<PermissionResult> {
  const check = bashToolCheckPermission(input, context, compoundHasCd, astCommand, shown)
  if (check.behavior === 'deny' || check.behavior === 'ask') return check
  if (check.behavior === 'allow') return check
  const suggestions = suggestionForCommand(input.command)
  return { ...check, suggestions } as PermissionResult
}

function rewriteReadOnlyGitCommand(command: string, cwd: string, depth = 0): string {
  if (depth > SHELL_C_MAX_DEPTH) return command
  const root = preparedCommandRoot(command)
  if (!root || root.type === 'ERROR') return command
  const spans: Array<{ start: number; end: number; text: string }> = []
  const visit = (node: Node): void => {
    if (node.type === 'command') {
      const parsed = preparedSecurityParse(node.text)
      const simple = parsed.kind === 'simple' && parsed.commands.length === 1 ? parsed.commands[0] : undefined
      if (simple && simple.envVars.length === 0 && simple.globOperand !== true && checkPreparedReadOnlyConstraints({ command: node.text, cwd }, false).behavior === 'allow') {
        if (simple.argv[0] === 'git') {
          const text = shellCommandText(['git', ...gitArgs(simple.argv.slice(1), cwd)])
          if (text !== node.text) spans.push({ start: node.startIndex, end: node.endIndex, text })
        } else {
          const script = extractShellCScript(simple)
          if (script !== null) {
            const rewritten = rewriteReadOnlyGitCommand(script, cwd, depth + 1)
            if (rewritten !== script) {
              const argv = [...simple.argv]
              argv[2] = rewritten
              spans.push({ start: node.startIndex, end: node.endIndex, text: shellCommandText(argv) })
            }
          }
        }
      }
    }
    for (const child of node.children) visit(child)
  }
  visit(root)
  let rewritten = command
  for (const span of spans.sort((a, b) => b.start - a.start)) rewritten = rewritten.slice(0, span.start) + span.text + rewritten.slice(span.end)
  return rewritten
}


type PrefixFn = (
  command: string,
  signal: AbortSignal,
  isNonInteractiveSession: boolean,
) => Promise<
  | { commandPrefix: string | null; subcommandPrefixes?: Map<string, { commandPrefix: string | null }> }
  | null
>

function asWrittenSingle(command: string, fallback: string, cwd: string): string {
  const posixCwd = getPlatform() === 'windows' ? windowsPathToPosixPath(cwd) : cwd
  const written = splitListSegments(command).filter(segment => segment !== `cd ${cwd}` && segment !== `cd ${posixCwd}`)
  return written.length === 1 ? (written[0] as string) : fallback
}

function filterCwdSubcommands(
  subcommands: string[],
  parsed: (SimpleCommand | undefined)[],
  cwd: string,
): { subcommands: string[]; parsed: (SimpleCommand | undefined)[] } {
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

const identityCheckers: CommandIdentityCheckers = {
  isGitCommand: isNormalizedGitCommand,
  isDirectoryChange: isNormalizedCdCommand,
}

export function bashToolHasPermission(
  input: BashInput,
  context: ToolPermissionContext,
  prefixFn: PrefixFn = pinnedCommandAnalysis.getCommandSubcommandPrefix,
): Promise<PermissionResult> {
  return withBashParseScope(async () => {
    const resolvedInput = input.cwd === undefined ? input : { ...input, cwd: resolveShellCwd(input.cwd) }
    const result = await decideBashPermission(resolvedInput, context, prefixFn)
    if (result.behavior === 'deny') return result
    const cwd = checkShellCwd(resolvedInput, context)
    if (cwd !== null) return cwd
    if (result.behavior !== 'allow') return result
    const carried = ('updatedInput' in result && result.updatedInput ? result.updatedInput : resolvedInput) as BashInput
    const merged = { ...resolvedInput, ...carried }
    return { ...result, updatedInput: { ...merged, command: rewriteReadOnlyGitCommand(merged.command, resolveShellCwd(merged.cwd)) } }
  })
}

async function decideBashPermission(
  input: BashInput,
  context: ToolPermissionContext,
  prefixFn: PrefixFn,
  depth = 0,
  inheritedHasCd = false,
): Promise<PermissionResult> {
  const command = input.command
  const cwd = resolveShellCwd(input.cwd)
  const selfProtection = await shellSelfProtectionReason(command, false, cwd)
  if (selfProtection !== null) return { behavior: 'deny', message: selfProtection, decisionReason: { type: 'other', reason: selfProtection } }
  const hidden = hiddenCommandCharacterReason(command)
  if (hidden !== null) return { behavior: 'deny', message: hidden, decisionReason: { type: 'safetyCheck', reason: hidden, operatorOnly: true } }
  const upload = credentialUploadReason(command)
  const uploadAsk: PermissionResult | null = upload === null ? null : { behavior: 'ask', message: upload, decisionReason: { type: 'safetyCheck', reason: upload, operatorOnly: true } }
  const astRoot = await pinnedCommandAnalysis.parseCommandRaw(command) ?? undefined
  const secretRead = await shellMercurySecretPath(command, false, cwd)
  if (secretRead !== null) {
    const message = 'Reading ' + secretRead + " is refused: it holds Mercury's own credentials; use the product's sign-in and account surfaces instead."
    return { behavior: 'deny', message, decisionReason: { type: 'other', reason: message } }
  }
  const protectedWrite = await shellCredentialWritePath(command, false, cwd)
  if (protectedWrite !== null) {
    const denied = astRoot === undefined ? earlyExitDenyCheck(input, context) : astDenyCheck(input, context, astRoot)
    if (denied) return denied
    const message = 'Writing ' + protectedWrite + ' affects a credential store and requires approval.'
    return { behavior: 'ask', message, decisionReason: { type: 'safetyCheck', reason: message, operatorOnly: false } }
  }
  const remote = uncPathRisk(command, { command: true })
  if (remote.risky) {
    const denied = earlyExitDenyCheck(input, context)
    if (denied) return denied
    if (!matchRules(command.trim(), context, 'allow', 'exact', false)) {
      const message = uncPathMessage(command, remote)
      return { behavior: 'ask', message, decisionReason: { type: 'safetyCheck', reason: message, operatorOnly: true } }
    }
  }
  let compoundHasCd = inheritedHasCd
  const customPrefixFn = prefixFn !== pinnedCommandAnalysis.getCommandSubcommandPrefix

  let astCommands: SimpleCommand[] | null = null
  if (command.length > 10_000) {
    return earlyExitDenyCheck(input, context) ?? unprovenAsk('the command exceeds the parser’s 10,000-character limit; split it into shorter commands, or approve')
  }
  if (astRoot !== undefined) {
    const parsed = await parseForSecurity(command)
    await prepareShellCScripts(parsed, depth)
    const denied = astDenyCheck(input, context, astRoot)
    if (denied) return denied
    if (parsed.kind === 'too-complex') return uploadAsk ?? unprovenAsk(parsed.reason)
    if (parsed.kind === 'simple') {
      const early = semanticsDenyCheck(input, context, parsed.commands)
      if (early) return early
      if (uploadAsk !== null) return uploadAsk
      const semantic = pinnedCommandAnalysis.checkSemantics(parsed.commands)
      if (!semantic.ok) return unprovenAsk(semantic.reason)
      astCommands = parsed.commands
      compoundHasCd ||= astCommands.some(simple => isNormalizedCdCommand(simple.text))
    }
  } else {
    return earlyExitDenyCheck(input, context) ?? uploadAsk ?? unprovenAsk('the shell parser is unavailable for this command; retry it, or approve')
  }

  if (astCommands === null) return unprovenAsk('the shell parser could not establish the commands; simplify the command, or approve')
  if (astCommands.some(simple => simple.globOperand === true && !wildcardAnswered(simple, context, compoundHasCd))) return unprovenAsk(WILDCARD_REASON)

  const exact = bashToolCheckExactMatchPermission(input, context)
  if (exact.behavior === 'deny') return exact

  const operator = await checkCommandOperatorPermissions(
    input,
    segmentInput => decideBashPermission(segmentInput, context, prefixFn, depth, inheritedHasCd),
    identityCheckers,
    astRoot,
  )
  if (operator.behavior !== 'passthrough') {
    if (operator.behavior === 'deny') return operator
    const path = checkPathConstraints(input, cwd, context, compoundHasCd, astCommands.flatMap(simple => simple.redirects), astCommands)
    if (path.behavior === 'deny') return path
    if (exact.behavior === 'ask') return exact
    if (operator.behavior === 'allow') return path.behavior !== 'passthrough' ? path : operator
    return operator
  }

  const rawSubcommands = astCommands.map(simple => simple.text)
  const rawParsed = astCommands
  const filtered = filterCwdSubcommands(rawSubcommands, rawParsed, cwd)
  const subcommands = filtered.subcommands
  const parsedSubcommands = filtered.parsed

  if (subcommands.filter(sub => isNormalizedCdCommand(sub)).length > 1) {
    return { behavior: 'ask', message: MULTIPLE_CD_REASON, decisionReason: { type: 'other', reason: MULTIPLE_CD_REASON } }
  }

  if (subcommands.some(isNormalizedCdCommand) && subcommands.some(isNormalizedGitCommand)) {
    return { behavior: 'ask', message: CD_GIT_BARE_REPO_REASON, decisionReason: { type: 'other', reason: CD_GIT_BARE_REPO_REASON } }
  }

  const decisions = await Promise.all(subcommands.map(async (sub, i) => {
    const simple = parsedSubcommands[i]
    const outer = bashToolCheckPermission({ ...input, command: sub }, context, compoundHasCd, simple)
    const script = simple && depth < SHELL_C_MAX_DEPTH ? extractShellCScript(simple) : null
    if (script === null || outer.behavior === 'deny') return outer
    const inner = await decideBashPermission({ ...input, command: script }, context, prefixFn, depth + 1, compoundHasCd)
    if (inner.behavior === 'deny') return inner
    if (outer.behavior === 'ask' || inner.behavior === 'ask') return outer.behavior === 'ask' ? outer : inner
    return outer.behavior === 'allow' ? outer : inner
  }))

  const denied = decisions.find(d => d.behavior === 'deny')
  if (denied) {
    const deniedReason = 'decisionReason' in denied ? denied.decisionReason : undefined
    const words = deniedReason?.type === 'rule' ? deniedReason.rule.ruleValue.reason : undefined
    const sentence = deniedReason?.type === 'rule' ? denied.message : refusalWithReason('A subcommand was denied.', words)
    return { behavior: 'deny', message: sentence, decisionReason: subcommandResultsReason(subcommands, decisions) }
  }

  const originalPath = checkPathConstraints(
    input,
    cwd,
    context,
    compoundHasCd,
    astCommands ? astCommands.flatMap(c => c.redirects) : undefined,
    astCommands ?? undefined,
  )
  if (originalPath.behavior === 'deny') return originalPath
  if (exact.behavior === 'ask') return exact

  const anySubcommandAsked = decisions.some(d => d.behavior === 'ask')
  if (originalPath.behavior === 'ask' && !anySubcommandAsked) return originalPath

  const nonAllow = decisions.filter(d => d.behavior !== 'allow')
  if (nonAllow.length === 1 && (nonAllow[0] as PermissionResult).behavior === 'ask') {
    return nonAllow[0] as PermissionResult
  }

  if (exact.behavior === 'allow' && !anySubcommandAsked) return exact

  if (decisions.every(d => d.behavior === 'allow')) {
    return { behavior: 'allow', updatedInput: input, decisionReason: subcommandResultsReason(subcommands, decisions) }
  }

  let prefixHint:
    | { commandPrefix: string | null; subcommandPrefixes?: Map<string, { commandPrefix: string | null }> }
    | null = null
  if (customPrefixFn) {
    const signal = pickSignal(context)
    prefixHint = await prefixFn(command, signal, false)
    if (signal.aborted) throwAbort()
  }

  if (subcommands.length === 1) {
    const single = await checkCommandAndSuggestRules(
      { ...input, command: subcommands[0] as string },
      context,
      prefixHint,
      compoundHasCd,
      asWrittenSingle(command, subcommands[0] as string, cwd),
      parsedSubcommands[0],
    )
    return single
  }

  const merged = await Promise.all(
    subcommands.map((sub, index) =>
      decisions[index]!.behavior !== 'passthrough' ? decisions[index]! : checkCommandAndSuggestRules(
        { ...input, command: sub },
        context,
        prefixHint?.subcommandPrefixes?.get(sub) ?? null,
        compoundHasCd,
        undefined,
        parsedSubcommands[index],
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
  const behavior = anySubcommandAsked ? 'ask' : 'passthrough'
  return {
    behavior,
    message: createPermissionRequestMessage(TOOL_NAME, reason),
    decisionReason: reason,
    ...(collected.length > 0 ? { suggestions: collected } : {}),
  } as PermissionResult
}

function subcommandResultsReason(subcommands: string[], results: PermissionResult[]): PermissionDecisionReason {
  const map = new Map<string, PermissionResult>()
  subcommands.forEach((sub, i) => map.set(sub, results[i] as PermissionResult))
  return { type: 'subcommandResults', reasons: map }
}

function earlyExitDenyCheck(input: BashInput, context: ToolPermissionContext): PermissionResult | null {
  const exact = bashToolCheckExactMatchPermission(input, context)
  if (exact.behavior === 'deny') return exact
  const deny = matchRules(input.command.trim(), context, 'deny', 'prefix', true)
  if (deny !== null) {
    return denyByRule(context, input.command, deny, () => matchAllRules(input.command.trim(), context, 'deny', 'prefix', true))
  }
  return null
}

function unprovenAsk(reason: string): PermissionResult {
  const message = /approve|approval/i.test(reason) ? reason : `${reason}; simplify the command, or approve`
  return { behavior: 'ask', message, decisionReason: { type: 'safetyCheck', reason: message, operatorOnly: false } }
}

function wildcardAnswered(command: SimpleCommand, context: ToolPermissionContext, compoundHasCd: boolean): boolean {
  const text = command.text.trim()
  if (matchRules(text, context, 'allow', 'exact', true) !== null || matchRules(text, context, 'allow', 'prefix', true) !== null) return true
  return (context.mode === 'flow' || context.probedFrom === 'flow') && checkPreparedReadOnlyConstraints({ command: text }, compoundHasCd, { ...command, redirects: [] }).behavior === 'allow'
}

function astDenyCheck(input: BashInput, context: ToolPermissionContext, root: Node | typeof PARSE_ABORTED): PermissionResult | null {
  const early = earlyExitDenyCheck(input, context)
  if (early || root === PARSE_ABORTED) return early
  const stack = [root]
  while (stack.length) {
    const node = stack.pop()!
    if (node.type === 'command' || node.type === 'declaration_command') {
      const candidates = [node.text]
      const parsed = pinnedCommandAnalysis.parseForSecurityFromAst(node.text, node)
      if (parsed.kind === 'simple') candidates.push(...parsed.commands.flatMap(simple => restrictedCommandCandidates(simple)))
      const name = node.children.find(child => child.type === 'command_name')
      if (name) {
        const named = pinnedCommandAnalysis.parseForSecurityFromAst(name.text, { ...node, children: [name] })
        if (named.kind === 'simple' && named.commands[0]?.argv[0]) {
          candidates.push(named.commands[0].argv[0] + node.text.slice(name.endIndex - node.startIndex))
        }
      }
      for (const candidate of candidates) {
        const deny = matchRules(candidate, context, 'deny', 'prefix', true)
        if (deny !== null) return denyByRule(context, input.command, deny, () => matchAllRules(candidate, context, 'deny', 'prefix', true))
      }
    }
    stack.push(...node.children)
  }
  return null
}

function wrappedCommand(argv: string[]): string[] | null {
  const [name] = argv
  if (name === 'time' && argv[1]?.startsWith('-') && argv[1].slice(1) === 'p') return argv.slice(2)
  if (name === 'command' || name === 'builtin' || name === 'exec') {
    let i = 1
    while (i < argv.length && argv[i]!.startsWith('-')) {
      const flag = argv[i++]!
      if (flag === '--') break
      if (name === 'command' && /^p+$/.test(flag.slice(1))) continue
      if (name === 'exec' && /^-[cl]+$/.test(flag)) continue
      if (name === 'exec' && flag === '-a' && argv[i] !== undefined) { i++; continue }
      if (name === 'exec' && flag.startsWith('-a') && flag.length > 2) continue
      return null
    }
    return argv.slice(i)
  }
  if (name === 'xargs') {
    let i = 1
    while (i < argv.length && argv[i]!.startsWith('-')) {
      const flag = argv[i++]!
      if (flag === '--') break
      if (/^--(?:null|no-run-if-empty|verbose|interactive|exit)$/.test(flag)) continue
      if (/^--(?:arg-file|delimiter|eof|replace|max-lines|max-args|max-procs|max-chars)=/.test(flag)) continue
      if (/^--(?:arg-file|delimiter|eof|replace|max-lines|max-args|max-procs|max-chars)$/.test(flag)) { i++; continue }
      if (flag.startsWith('--')) return null
      let valid = flag.length > 1
      for (let j = 1; j < flag.length; j++) {
        const letter = flag[j]!
        if ('0rtpx'.includes(letter)) continue
        if ('aEdILnPs'.includes(letter)) {
          if (j === flag.length - 1) i++
          break
        }
        if ('eil'.includes(letter)) break
        valid = false
        break
      }
      if (!valid) return null
    }
    return argv.slice(i)
  }
  const peeled = peelWrappers(argv)
  return Array.isArray(peeled) && peeled !== argv ? peeled : null
}

function restrictedCommandCandidates(command: SimpleCommand, depth = 0): string[] {
  const candidates = new Set([command.text.trim(), shellCommandText(command.argv)])
  const script = depth < SHELL_C_MAX_DEPTH ? extractShellCScript(command) : null
  if (script !== null) {
    candidates.add(script)
    const inner = preparedSecurityParse(script)
    if (inner.kind === 'simple') {
      for (const simple of inner.commands) {
        for (const candidate of restrictedCommandCandidates(simple, depth + 1)) candidates.add(candidate)
      }
    }
  }
  const pending = [command.argv]
  while (pending.length) {
    const argv = pending.pop()!
    const wrapped = wrappedCommand(argv)
    if (wrapped?.length) {
      candidates.add(shellCommandText(wrapped))
      pending.push(wrapped)
    }
    if (argv[0] === 'find') {
      for (let i = 1; i < argv.length; i++) {
        if (!['-exec', '-execdir', '-ok', '-okdir'].includes(argv[i]!)) continue
        const start = ++i
        while (i < argv.length && argv[i] !== ';' && argv[i] !== '+') i++
        const target = argv.slice(start, i)
        if (target.length) { candidates.add(shellCommandText(target)); pending.push(target) }
      }
    }
  }
  return [...candidates]
}

function semanticsDenyCheck(input: BashInput, context: ToolPermissionContext, commands: SimpleCommand[]): PermissionResult | null {
  const early = earlyExitDenyCheck(input, context)
  if (early) return early
  for (const command of commands) {
    for (const candidate of restrictedCommandCandidates(command)) {
      const deny = matchRules(candidate, context, 'deny', 'exact', true) ?? matchRules(candidate, context, 'deny', 'prefix', true)
      if (deny !== null) {
        return denyByRule(context, command.text, deny, () => [...matchAllRules(candidate, context, 'deny', 'exact', true), ...matchAllRules(candidate, context, 'deny', 'prefix', true)])
      }
    }
  }
  return null
}


function pickSignal(context: ToolPermissionContext): AbortSignal {
  const anyContext = context as unknown as { abortController?: { signal: AbortSignal } }
  return anyContext.abortController?.signal ?? (new AbortController().signal as unknown as AbortSignal)
}

function throwAbort(): never {
  const error = new Error('The operation was aborted')
  error.name = 'AbortError'
  throw error
}
