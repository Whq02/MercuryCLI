import { getEmptyToolPermissionContext, type ToolPermissionContext, type ToolUseContext } from '../../Tool.js'
import type {
  PermissionResult,
  PermissionDecisionReason,
} from '../../utils/permissions/PermissionResult.js'
import { resolveShellCwd } from '../../utils/Shell.js'
import { hiddenCommandCharacterReason } from '../../utils/sanitization.js'
import { credentialUploadReason } from '../../utils/permissions/commandContent.js'
import { ruleWords } from '../../utils/permissions/ruleReason.js'
import { uncPathRisk, uncPathMessage } from '../../utils/permissions/uncPath.js'
import { shellFolderComparisonKey } from '../../utils/platform/commandForms.js'
import { nativePathToShell } from '../../utils/platform/paths.js'
import { createPermissionRequestMessage } from '../../utils/permissions/decision/requestMessage.js'
import { getRuleByContentsForToolName } from '../../utils/permissions/decision/rules.js'
import { permissionRuleValueFromString, permissionRuleValueToString } from '../../utils/permissions/permissionRuleParser.js'
import {
  knownShellCommandPrefix,
  matchWildcardPattern,
  permissionRuleExtractPrefix,
  suggestionForExactCommand,
  suggestionForPrefix,
} from '../../utils/permissions/shellRuleMatching.js'
import {
  askByRule,
  denyByRule,
  matchAllRules,
  matchRules,
  readBashRuleVerdict,
  ruleFor,
  ruleReason,
  stripAllLeadingEnvVars,
} from '../../utils/permissions/bashRuleVerdict.js'
import {
  withBashParseScope,
  parseForSecurity,
  preparedCommandSpans,
  extractShellCScript,
  prepareShellCScripts,
  shellCCommands,
  SHELL_C_MAX_DEPTH,
  preparedSecurityParse,
  peelWrappers,
  shellCommandText,
  commandSpans,
  pinnedCommandAnalysis,
  splitListSegments,
  WILDCARD_REASON,
  type SimpleCommand,
} from '../../utils/permissions/decision/commandAnalysis.js'
import {
  checkCommandOperatorPermissions,
  CD_GIT_BARE_REPO_REASON,
  MULTIPLE_CD_REASON,
  type CommandIdentityCheckers,
} from './bashCommandHelpers.js'
import { checkPermissionMode } from './modeValidation.js'
import { denyRuleReach, hiddenDenyRuleAsk, hiddenDenyRuleRefusal, type HiddenDenyRule, type ReachBudget } from './denyRuleReach.js'
import { modeBypassesPermissions, permissionModeTitle } from '../../utils/permissions/PermissionMode.js'
import { checkPathConstraints, checkShellCwd } from './pathValidation.js'
import { checkPreparedReadOnlyConstraints, checkReadOnlyConstraints, cutPart, notReadOnlyClause, type NotReadOnly } from './readOnlyValidation.js'
import { checkSedConstraints } from '../../utils/shell/sedValidation.js'
import { shellCredentialWritePath, shellMercurySecretPath, shellSelfProtectionReason } from '../../utils/permissions/shellProtectedPaths.js'
import { credentialStoreWriteRefusal, isInstructionEstatePath } from '../../utils/permissions/filesystem.js'
import { credentialStorePath } from '../../utils/permissions/protectedPaths.js'
import { gitArgs, gitSubcommandIndex } from '../../utils/git/spawnArgs.js'
import { isCurrentDirectoryBareGitRepo } from '../../utils/git.js'
import { posix as posixPath } from 'node:path'
import { stripLeadingSafeEnvVars, stripSafeWrappers } from '../../utils/permissions/safeWrappers.js'
import { passedOver } from '../../utils/passedOver.js'

export { matchWildcardPattern, permissionRuleExtractPrefix, readBashRuleVerdict, stripAllLeadingEnvVars, stripSafeWrappers }

const TOOL_NAME = 'Bash'

const MAX_SUGGESTED_RULES_FOR_COMPOUND = 5

type BashInput = {
  command: string
  cwd?: string
  timeout?: number
  description?: string
  _simulatedSedEdit?: unknown
}


function suggestedCommandPrefix(command: string): string | null {
  let current = command.trim()
  for (;;) {
    const next = stripLeadingSafeEnvVars(current).trim()
    if (next === current) break
    current = next
  }
  return knownShellCommandPrefix(current)
}

export function getSimpleCommandPrefix(command: string): string | null {
  const prefix = suggestedCommandPrefix(command)
  return prefix !== null && prefix.includes(' ') ? prefix : null
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


const CURRENT_FOLDER_RELATIVE = /^\.(?:[\\/]\.?)*[\\/]?$/

export function isCurrentFolderSpelling(spelled: string, cwd: string): boolean {
  return shellFolderComparisonKey(spelled) === shellFolderComparisonKey(cwd) || CURRENT_FOLDER_RELATIVE.test(spelled)
}

function isCurrentDirectoryCommand(command: SimpleCommand, cwd: string): boolean {
  return command.argv.length === 2 && command.argv[0] === 'cd' &&
    isCurrentFolderSpelling(command.argv[1] ?? '', cwd) &&
    command.envVars.length === 0 && command.redirects.length === 0 &&
    isCurrentDirectoryBareGitRepo(cwd) === false
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

export function bashToolCheckPermission(
  input: BashInput,
  context: ToolPermissionContext,
  compoundHasCd = false,
  astCommand?: SimpleCommand,
  shown?: string,
): PermissionResult {
  const command = input.command.trim()
  const exact = bashToolCheckExactMatchPermission(input, context)
  if (exact.behavior === 'deny') return exact

  const parsed = astCommand ? { kind: 'simple' as const, commands: [astCommand] } : preparedSecurityParse(input.command)
  if (parsed.kind !== 'simple') {
    return unprovenAsk(
      parsed.kind === 'too-complex'
        ? parsed.reason
        : 'the shell parser could not produce a syntax tree for this command',
    )
  }
  const semantics = pinnedCommandAnalysis.checkSemantics(parsed.commands)
  if (!semantics.ok) return unprovenAsk(semantics.reason)
  if (parsed.commands.length !== 1) {
    return unprovenAsk('this command contains more than one simple command')
  }
  const simple = parsed.commands[0]!

  if (exact.behavior === 'ask') return exact

  const prefixDeny = matchRules(command, context, 'deny', 'prefix', true)
  if (prefixDeny !== null) {
    return denyByRule(context, command, prefixDeny, () => matchAllRules(command, context, 'deny', 'prefix', true))
  }
  const prefixAsk = matchRules(command, context, 'ask', 'prefix', true)
  if (prefixAsk !== null) {
    return askByRule(context, command, prefixAsk)
  }

  const cwd = resolveShellCwd(input.cwd)
  const pathResult = checkPathConstraints(input, cwd, context, compoundHasCd, simple.redirects, [simple])
  if (pathResult.behavior !== 'passthrough') return pathResult

  if (exact.behavior === 'allow') return exact
  const prefixAllow = matchRules(command, context, 'allow', 'prefix', false)
  if (prefixAllow !== null) {
    return { behavior: 'allow', updatedInput: input, decisionReason: ruleReason(context, prefixAllow, 'allow') }
  }

  const sedResult = checkSedConstraints(input, context)
  if (sedResult.behavior !== 'passthrough') return sedResult

  const modeResult = checkPermissionMode(input, context)
  if (modeResult.behavior !== 'passthrough') return modeResult

  if (!compoundHasCd && isCurrentDirectoryCommand(simple, cwd)) {
    return {
      behavior: 'allow',
      updatedInput: input,
      decisionReason: { type: 'other', reason: 'The directory is already current' },
    }
  }

  const readOnly = checkPreparedReadOnlyConstraints(input, compoundHasCd, { ...simple, redirects: [] })
  if (readOnly.behavior === 'allow') {
    return {
      behavior: 'allow',
      updatedInput: input,
      decisionReason: { type: 'other', reason: 'Read-only command is allowed' },
    }
  }

  const label = cutPart((shown ?? command).trim())
  const clause = readOnly.notReadOnly ? notReadOnlyClause(readOnly.notReadOnly).trim() : ''
  const sentence =
    clause === ''
      ? `\`${label}\` requires approval.`
      : /[.!?]$/.test(clause)
        ? `\`${label}\` requires approval: ${clause}`
        : `\`${label}\` requires approval: ${clause}.`

  return {
    behavior: 'passthrough',
    message: sentence,
    decisionReason: { type: 'other', reason: sentence },
    suggestions: suggestionForExactCommand(TOOL_NAME, command),
  }
}

async function checkCommandAndSuggestRules(
  input: BashInput,
  context: ToolPermissionContext,
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

export function rewriteReadOnlyGitCommand(command: string, cwd: string, depth = 0): string {
  if (depth > SHELL_C_MAX_DEPTH) return command
  const nodes = preparedCommandSpans(command)
  if (nodes === null) return command
  const spans: Array<{ start: number; end: number; text: string }> = []
  for (const node of nodes) {
    if (node.declaration) continue
    const parsed = node.exact()
    if (parsed.kind !== 'simple' || parsed.commands.length !== 1) continue
    const simple = parsed.commands[0]!
    if (simple.envVars.length > 0 || simple.globOperand) continue
    if (checkPreparedReadOnlyConstraints({ command: node.text, cwd }, false, simple, depth).behavior !== 'allow') continue
    if (simple.argv[0] === 'git') {
      const rewrittenArgs = gitArgs(simple.argv.slice(1), cwd)
      if (
        rewrittenArgs.length !== simple.argv.length - 1 ||
        rewrittenArgs.some((arg, index) => arg !== simple.argv[index + 1])
      ) {
        spans.push({ start: node.start, end: node.end, text: shellCommandText(['git', ...rewrittenArgs]) })
      }
      continue
    }
    const script = extractShellCScript(simple)
    if (script !== null) {
      const rewrittenScript = rewriteReadOnlyGitCommand(script, cwd, depth + 1)
      if (rewrittenScript !== script) {
        const nextArgv = [...simple.argv]
        nextArgv[2] = rewrittenScript
        spans.push({ start: node.start, end: node.end, text: shellCommandText(nextArgv) })
      }
    }
  }
  if (spans.length === 0) return command
  let rewritten = command
  for (const span of spans.sort((a, b) => b.start - a.start)) {
    rewritten = rewritten.slice(0, span.start) + span.text + rewritten.slice(span.end)
  }
  return rewritten
}


function asWrittenSingle(command: string, fallback: string, cwd: string): string {
  const posixCwd = nativePathToShell(cwd)
  const written = splitListSegments(command).filter(segment => segment !== `cd ${cwd}` && segment !== `cd ${posixCwd}`)
  return written.length === 1 ? (written[0] as string) : fallback
}


const identityCheckers: CommandIdentityCheckers = {
  isGitCommand: isNormalizedGitCommand,
  isDirectoryChange: isNormalizedCdCommand,
}

type TwoParameters<F extends (...args: never[]) => unknown> = [Parameters<F>['length']] extends [2] ? ([2] extends [Parameters<F>['length']] ? F : never) : never

function ruleEntry(
  input: BashInput,
  context: ToolPermissionContext,
): Promise<PermissionResult> {
  return shellTextVerdict(input, context, true)
}

export const bashToolHasPermission: TwoParameters<typeof ruleEntry> = ruleEntry

function shellTextVerdict(input: BashInput, context: ToolPermissionContext, knownForCommand: boolean): Promise<PermissionResult> {
  return withBashParseScope(async () => {
    const resolvedInput = input.cwd === undefined ? input : { ...input, cwd: resolveShellCwd(input.cwd) }
    const reached = await decideWithDenyRuleReach(resolvedInput, context, 0)
    if (reached.result.behavior === 'deny') return reached.result
    const unread = reached.unread
    const printed = unread !== null && reached.result.behavior === 'allow' ? unprovenAsk(`${unread.why}, and ${ruleWords(unread.rule)} denies what it may print; name the paths it should print, or approve`) : reached.result
    const hidden = reached.hidden ?? unread
    if (knownForCommand && hidden !== null && printed.behavior !== 'allow' && (modeBypassesPermissions(context.mode) || context.mode === 'flow')) {
      return hiddenDenyRuleRefusal(hidden, permissionModeTitle(context.mode))
    }
    const result = knownForCommand && reached.hidden !== null && printed.behavior !== 'allow' ? hiddenDenyRuleAsk(reached.hidden) : printed
    const cwd = checkShellCwd(resolvedInput, context)
    if (cwd !== null) return cwd
    if (context.mode === 'flow' && result.behavior !== 'allow' && !keptByFlow(result)) {
      const named = await namesMercuryConfiguration(resolvedInput, context, 0)
      if (named !== null) return { behavior: 'ask', message: named, decisionReason: { type: 'safetyCheck', reason: named, operatorOnly: true } } as PermissionResult
    }
    if (result.behavior !== 'allow') return result
    const carried = ('updatedInput' in result && result.updatedInput ? result.updatedInput : resolvedInput) as BashInput
    const merged = { ...resolvedInput, ...carried }
    return { ...result, updatedInput: { ...merged, command: rewriteReadOnlyGitCommand(merged.command, resolveShellCwd(merged.cwd)) } }
  })
}

function keptByFlow(result: PermissionResult): boolean {
  if (result.behavior !== 'ask') return false
  const reason = result.decisionReason
  if (reason?.type === 'safetyCheck') return reason.operatorOnly
  if (reason?.type !== 'subcommandResults') return false
  for (const sub of reason.reasons.values()) if (keptByFlow(sub)) return true
  return false
}

async function namesMercuryConfiguration(input: BashInput, context: ToolPermissionContext, depth: number, budget?: ReachBudget): Promise<string | null> {
  const plain = { ...context, alwaysDenyRules: {} } as ToolPermissionContext
  const reach = await denyRuleReach(input.command, resolveShellCwd(input.cwd), plain, {
    judge: async (command, cwd, left) => {
      const inner = await decideBashPermission({ ...input, command, cwd }, plain)
      if (keptByFlow(inner)) return { denied: inner, hidden: null }
      const named = inner.behavior === 'allow' ? null : await namesMercuryConfiguration({ ...input, command, cwd }, context, depth + 1, left)
      return { denied: named === null ? null : ({ behavior: 'deny', message: named, decisionReason: { type: 'other', reason: named } } as PermissionResult), hidden: null }
    },
    bashDenyRule: () => null,
    optionNamedWrites,
    estate: path => isInstructionEstatePath(path, true),
  }, depth, budget)
  if (reach.denied !== null) {
    const said = 'message' in reach.denied && typeof reach.denied.message === 'string' ? reach.denied.message : ''
    return reach.denied.behavior === 'ask' || /^Permission /.test(said) ? said : `Permission to run this command is required: ${said}.`
  }
  return reach.hidden === null ? null : `Permission to run this command is required: ${reach.hidden.why}, which is Mercury's configuration.`
}

async function decideWithDenyRuleReach(
  input: BashInput,
  context: ToolPermissionContext,
  depth: number,
  budget?: ReachBudget,
): Promise<{ result: PermissionResult; hidden: HiddenDenyRule | null; unread: HiddenDenyRule | null }> {
  const result = await decideBashPermission(input, context)
  if (result.behavior === 'deny') return { result, hidden: null, unread: null }
  const reach = await denyRuleReach(input.command, resolveShellCwd(input.cwd), context, {
    judge: async (command, cwd, left) => {
      const inner = await decideWithDenyRuleReach({ ...input, command, cwd }, context, depth + 1, left)
      return inner.result.behavior === 'deny' ? { denied: inner.result, hidden: null } : { denied: null, hidden: inner.hidden, unread: inner.unread }
    },
    bashDenyRule: candidate => {
      const deny = matchRules(candidate, context, 'deny', 'exact', true) ?? matchRules(candidate, context, 'deny', 'prefix', true)
      return deny === null ? null : ruleFor(context, deny, 'deny')
    },
    optionNamedWrites,
    readOnly: async (command, cwd) => {
      try {
        return (await checkReadOnlyConstraints({ command, cwd }, false)).behavior === 'allow'
      } catch (error) {
        passedOver(error)
        return false
      }
    },
  }, depth, budget)
  return reach.denied !== null ? { result: reach.denied, hidden: null, unread: null } : { result, hidden: reach.hidden, unread: reach.unread ?? null }
}

type RulesBySource = ToolPermissionContext['alwaysAllowRules']

type RuleSourceKey = keyof RulesBySource
type MutableRuleReasons = Partial<Record<RuleSourceKey, Record<string, string>>>

function contentRulesReadAsBash(context: ToolPermissionContext, toolName: string): { context: ToolPermissionContext; own: Set<string> } {
  const own = new Set<string>()
  if (toolName === TOOL_NAME) return { context, own }

  let nextReasons: MutableRuleReasons | undefined
  const ensureReasons = (): MutableRuleReasons => {
    if (nextReasons === undefined) {
      const cloned: MutableRuleReasons = {}
      if (context.ruleReasons) {
        for (const [source, map] of Object.entries(context.ruleReasons) as Array<[RuleSourceKey, Record<string, string> | undefined]>) {
          if (map) cloned[source] = { ...map }
        }
      }
      nextReasons = cloned
    }
    return nextReasons
  }

  const projectMap = (map: RulesBySource): RulesBySource => {
    let changed = false
    const out: RulesBySource = {}
    for (const [source, rules] of Object.entries(map) as Array<[RuleSourceKey, string[] | undefined]>) {
      if (!rules) continue
      const projected = [...rules]
      for (const raw of rules) {
        const parsed = permissionRuleValueFromString(raw)
        if (parsed.toolName !== toolName || parsed.ruleContent === undefined) continue
        own.add(parsed.ruleContent)
        const bashSpelling = permissionRuleValueToString({ toolName: TOOL_NAME, ruleContent: parsed.ruleContent })
        if (!projected.includes(bashSpelling)) {
          projected.push(bashSpelling)
          changed = true
        }
        const sourceReasons = context.ruleReasons?.[source]
        const ownReason = sourceReasons?.[raw]
        if (ownReason !== undefined && sourceReasons?.[bashSpelling] === undefined) {
          const targetReasons = ensureReasons()
          const targetSource = targetReasons[source] ?? (targetReasons[source] = {})
          if (targetSource[bashSpelling] === undefined) {
            targetSource[bashSpelling] = ownReason
          }
        }
      }
      out[source] = projected
    }
    return changed ? out : map
  }

  const alwaysAllowRules = projectMap(context.alwaysAllowRules)
  const alwaysDenyRules = projectMap(context.alwaysDenyRules)
  const alwaysAskRules = projectMap(context.alwaysAskRules)

  if (own.size === 0) return { context, own }
  return {
    context: {
      ...context,
      alwaysAllowRules,
      alwaysDenyRules,
      alwaysAskRules,
      ...(nextReasons !== undefined ? { ruleReasons: nextReasons } : {}),
    },
    own,
  }
}

function spelledForTool(result: PermissionResult, context: ToolPermissionContext, toolName: string, own: ReadonlySet<string>): PermissionResult {
  const reason = 'decisionReason' in result ? result.decisionReason : undefined
  if (reason?.type !== 'rule' || reason.rule.ruleValue.toolName !== TOOL_NAME) return result
  const content = reason.rule.ruleValue.ruleContent
  if (content === undefined || !own.has(content)) return result
  if (getRuleByContentsForToolName(context, TOOL_NAME, reason.rule.ruleBehavior).has(content)) return result
  const bashSpelling = permissionRuleValueToString(reason.rule.ruleValue)
  const ownSpelling = permissionRuleValueToString({ toolName, ruleContent: content })
  return {
    ...result,
    ...('message' in result && typeof result.message === 'string' ? { message: result.message.replaceAll(bashSpelling, ownSpelling) } : {}),
    decisionReason: { ...reason, rule: { ...reason.rule, ruleValue: { ...reason.rule.ruleValue, toolName } } },
  } as PermissionResult
}

export async function shellCommandHasPermission(
  toolName: string,
  input: BashInput,
  context: ToolPermissionContext,
): Promise<PermissionResult> {
  const read = contentRulesReadAsBash(context, toolName)
  const decided = await bashToolHasPermission(input, read.context)
  const result = read.own.size === 0 ? decided : spelledForTool(decided, context, toolName, read.own)
  if ((result.behavior !== 'ask' && result.behavior !== 'passthrough') || ('suggestions' in result && result.suggestions !== undefined)) return result
  const namedAtRunTime = /[$`]/.test(input.command.replace(/'[^']*'/g, ''))
  return { ...result, suggestions: namedAtRunTime ? [] : suggestionForCommand(input.command) } as PermissionResult
}

export async function startedCommandVerdict(
  started: ReadonlyArray<{ command: string; cwd?: string }>,
  toolUseContext: Pick<ToolUseContext, 'getAppState'> | undefined,
  own: PermissionResult & { message: string },
  knownForCommand = true,
): Promise<PermissionResult> {
  const context = (toolUseContext?.getAppState?.().toolPermissionContext ?? getEmptyToolPermissionContext()) as ToolPermissionContext
  let held: PermissionResult | null = null
  for (const one of started) {
    const verdict = await shellTextVerdict(one.cwd === undefined ? { command: one.command } : { command: one.command, cwd: one.cwd }, context, knownForCommand)
    if (verdict.behavior === 'deny') return verdict
    if (verdict.behavior !== 'ask' || held !== null) continue
    const reason = verdict.decisionReason
    if (reason?.type === 'rule' || reason?.type === 'safetyCheck') held = { behavior: 'ask', message: `${own.message}\n${verdict.message}`, decisionReason: reason }
  }
  return held ?? own
}

function spanDenyCheck(astRoot: unknown, command: string, context: ToolPermissionContext): PermissionResult | null {
  for (const span of commandSpans(astRoot)) {
    const candidates = new Set<string>([span.text])
    if (span.name) {
      const resolved = span.name.ansiC ? decodeAnsiCString(span.name.text) : span.name.word()
      if (resolved !== undefined && resolved !== null && resolved !== '') {
        candidates.add(`${resolved}${span.name.rest}`)
        const base = posixPath.basename(resolved.replace(/\\/g, '/'))
        if (base !== resolved && base !== '') {
          candidates.add(`${base}${span.name.rest}`)
        }
      }
    }
    const exact = span.exact()
    if (exact.kind === 'simple') {
      for (const cmd of exact.commands) {
        for (const candidate of restrictedCommandCandidates(cmd)) candidates.add(candidate)
      }
    }
    for (const candidate of candidates) {
      const deny = matchRules(candidate, context, 'deny', 'exact', true) ?? matchRules(candidate, context, 'deny', 'prefix', true)
      if (deny !== null) {
        return denyByRule(context, span.text, deny, () => [
          ...matchAllRules(candidate, context, 'deny', 'exact', true),
          ...matchAllRules(candidate, context, 'deny', 'prefix', true),
        ])
      }
    }
  }
  for (const piece of pinnedCommandAnalysis.splitCommand(command)) {
    const trimmed = piece.trim()
    if (trimmed === '') continue
    const deny = matchRules(trimmed, context, 'deny', 'exact', true) ?? matchRules(trimmed, context, 'deny', 'prefix', true)
    if (deny !== null) {
      return denyByRule(context, trimmed, deny, () => [
        ...matchAllRules(trimmed, context, 'deny', 'exact', true),
        ...matchAllRules(trimmed, context, 'deny', 'prefix', true),
      ])
    }
  }
  return null
}

async function evaluateSimpleCommand(
  input: BashInput,
  simple: SimpleCommand,
  context: ToolPermissionContext,
  depth: number,
  compoundHasCd: boolean,
  shown?: string,
): Promise<PermissionResult> {
  if (depth < SHELL_C_MAX_DEPTH && simple.envVars.length === 0 && simple.redirects.length === 0) {
    const script = extractShellCScript(simple)
    if (script !== null) {
      const text = simple.text.trim()
      const outerDeny = matchRules(text, context, 'deny', 'exact', true) ?? matchRules(text, context, 'deny', 'prefix', true)
      if (outerDeny !== null) {
        return denyByRule(context, text, outerDeny, () => [
          ...matchAllRules(text, context, 'deny', 'exact', true),
          ...matchAllRules(text, context, 'deny', 'prefix', true),
        ])
      }
      const outerAsk = matchRules(text, context, 'ask', 'exact', true) ?? matchRules(text, context, 'ask', 'prefix', true)
      if (outerAsk !== null) {
        return askByRule(context, text, outerAsk)
      }
      const inner = await decideBashPermission({ ...input, command: script }, context, depth + 1, compoundHasCd)
      if (inner.behavior === 'deny' || inner.behavior === 'ask') return inner
      if (inner.behavior === 'allow') return { ...inner, updatedInput: input }
    }
  }
  return checkCommandAndSuggestRules({ ...input, command: simple.text }, context, compoundHasCd, shown, simple)
}

async function decideBashPermission(
  input: BashInput,
  context: ToolPermissionContext,
  depth = 0,
  inheritedHasCd = false,
): Promise<PermissionResult> {
  const cwd = resolveShellCwd(input.cwd)
  const command = input.command

  const hidden = hiddenCommandCharacterReason(command.replace(/\r\n/g, '\n'))
  if (hidden !== null) {
    return { behavior: 'deny', message: hidden, decisionReason: { type: 'other', reason: hidden } }
  }

  const selfProtect = await shellSelfProtectionReason(command, false, cwd)
  if (selfProtect !== null) {
    return { behavior: 'deny', message: selfProtect, decisionReason: { type: 'other', reason: selfProtect } }
  }

  const secret = await shellMercurySecretPath(command, false, cwd)
  if (secret !== null) {
    const message = `Reading ${secret} is refused: it holds Mercury's own credentials; use the product's sign-in and account surfaces instead.`
    return { behavior: 'deny', message, decisionReason: { type: 'other', reason: message } }
  }

  const credWrite = await shellCredentialWritePath(command, false, cwd)
  if (credWrite !== null) {
    const refusal = credentialStoreWriteRefusal(credWrite, cwd, context)
    if (refusal !== null) {
      return { behavior: 'deny', message: refusal, decisionReason: { type: 'other', reason: refusal } }
    }
  }

  const earlyDeny = earlyExitDenyCheck(input, context)
  if (earlyDeny !== null) return earlyDeny

  const astRoot = await pinnedCommandAnalysis.parseCommandRaw(command)
  const parsed = await parseForSecurity(command)
  await prepareShellCScripts(parsed)

  if (parsed.kind === 'simple') {
    const semDeny = semanticsDenyCheck(input, context, parsed.commands)
    if (semDeny !== null) return semDeny
    for (const simple of parsed.commands) {
      for (const target of optionNamedWrites(simple.argv)) {
        if (credentialStorePath(target, cwd) !== null) {
          const refusal = credentialStoreWriteRefusal(target, cwd, context)
          if (refusal !== null) {
            return { behavior: 'deny', message: refusal, decisionReason: { type: 'other', reason: refusal } }
          }
        }
      }
    }
  } else {
    const spanDeny = spanDenyCheck(astRoot, command, context)
    if (spanDeny !== null) return spanDeny
  }

  const remote = uncPathRisk(command, { command: true })
  if (remote.risky) {
    const message = uncPathMessage(command, remote)
    return { behavior: 'ask', message, decisionReason: { type: 'safetyCheck', reason: message, operatorOnly: true } }
  }

  const upload = credentialUploadReason(command)
  if (upload !== null) {
    return { behavior: 'ask', message: upload, decisionReason: { type: 'safetyCheck', reason: upload, operatorOnly: false } }
  }

  if (parsed.kind !== 'simple') {
    return unprovenAsk(
      parsed.kind === 'too-complex'
        ? parsed.reason
        : 'the shell parser could not produce a syntax tree for this command',
    )
  }

  const semantics = pinnedCommandAnalysis.checkSemantics(parsed.commands)
  if (!semantics.ok) return unprovenAsk(semantics.reason)

  const trimmed = command.trim()
  const wholeAsk = matchRules(trimmed, context, 'ask', 'exact', true) ?? matchRules(trimmed, context, 'ask', 'prefix', true)
  if (wholeAsk !== null) return askByRule(context, trimmed, wholeAsk)

  const nonCurrent = parsed.commands.filter(cmd => !isCurrentDirectoryCommand(cmd, cwd))
  const effective = nonCurrent.length > 0 ? nonCurrent : parsed.commands.slice(0, 1)

  let cdCount = 0
  let hasGit = false
  for (const cmd of effective) {
    if (!isCurrentDirectoryCommand(cmd, cwd) && isNormalizedCdCommand(cmd.text)) cdCount++
    if (isNormalizedGitCommand(cmd.text)) hasGit = true
  }
  const hasCd = inheritedHasCd || cdCount > 0

  if (effective.some(cmd => cmd.globOperand && !wildcardAnswered(cmd, context, hasCd))) {
    return unprovenAsk(WILDCARD_REASON)
  }

  const opResult = await checkCommandOperatorPermissions(
    input,
    segmentInput => decideBashPermission(segmentInput, context, depth, hasCd),
    identityCheckers,
    astRoot,
  )
  const isNotSegmented =
    opResult.behavior === 'passthrough' &&
    (opResult.message === 'Not a segmented command.' || opResult.message === 'Command could not be parsed for operator handling.')
  if (!isNotSegmented) {
    const allRedirects = parsed.commands.flatMap(cmd => cmd.redirects)
    const redirResult = checkPathConstraints(input, cwd, context, hasCd, allRedirects, [])
    if (redirResult.behavior === 'deny') return redirResult
    if (opResult.behavior === 'deny') return opResult
    if (redirResult.behavior !== 'passthrough') return redirResult
    return opResult
  }

  if (cdCount > 1) {
    return {
      behavior: 'ask',
      message: MULTIPLE_CD_REASON,
      decisionReason: { type: 'other', reason: MULTIPLE_CD_REASON },
    }
  }
  if (hasCd && hasGit) {
    return {
      behavior: 'ask',
      message: CD_GIT_BARE_REPO_REASON,
      decisionReason: { type: 'other', reason: CD_GIT_BARE_REPO_REASON },
    }
  }

  if (effective.length === 0) {
    return { behavior: 'allow', updatedInput: input, decisionReason: subcommandResultsReason([], []) }
  }

  const subcommands = effective.map(cmd => cmd.text)
  const results: PermissionResult[] = []
  for (const cmd of effective) {
    const shown =
      effective.length === 1
        ? parsed.commands.length > 1
          ? asWrittenSingle(command, cmd.text, cwd)
          : trimmed
        : cmd.text
    const result = await evaluateSimpleCommand(input, cmd, context, depth, hasCd, shown)
    results.push(result)
  }

  for (const result of results) {
    if (result.behavior === 'deny') {
      return {
        behavior: 'deny',
        message: result.message,
        decisionReason: subcommandResultsReason(subcommands, results),
      }
    }
  }

  if (results.every(result => result.behavior === 'allow')) {
    return {
      behavior: 'allow',
      updatedInput: input,
      decisionReason: subcommandResultsReason(subcommands, results),
    }
  }

  if (effective.length === 1) {
    const single = results[0]!
    if (single.behavior === 'passthrough') {
      const exact = bashToolCheckExactMatchPermission(input, context)
      if (exact.behavior === 'allow') return exact
    }
    return single
  }

  const asks = results.filter(result => result.behavior === 'ask')
  if (asks.length > 0) {
    const operatorAsk = asks.find(
      ask => ask.decisionReason?.type === 'safetyCheck' && ask.decisionReason.operatorOnly,
    )
    return operatorAsk ?? asks[0]!
  }

  const exact = bashToolCheckExactMatchPermission(input, context)
  if (exact.behavior === 'allow') return exact

  const decisionReason = subcommandResultsReason(subcommands, results)
  const suggestions = results
    .flatMap(result => (result.behavior === 'passthrough' ? (result.suggestions ?? []) : []))
    .slice(0, MAX_SUGGESTED_RULES_FOR_COMPOUND)
  const message = createPermissionRequestMessage(TOOL_NAME, decisionReason)
  return { behavior: 'passthrough', message, decisionReason, suggestions }
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
  return context.mode === 'flow' && checkPreparedReadOnlyConstraints({ command: text }, compoundHasCd, { ...command, redirects: [] }).behavior === 'allow'
}

const PRIVILEGE_VALUE_LETTERS = 'ugCDhprtTURa'
const PRIVILEGE_VALUE_LONGS = new Set(['--user', '--group', '--close-from', '--chdir', '--host', '--prompt', '--role', '--type', '--command-timeout', '--other-user', '--chroot'])

function privilegeTarget(argv: string[]): string[] {
  let i = 1
  while (i < argv.length) {
    const word = argv[i] as string
    if (word === '--') {
      i++
      break
    }
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(word)) {
      i++
      continue
    }
    if (!word.startsWith('-')) break
    if (word.startsWith('--')) {
      i += PRIVILEGE_VALUE_LONGS.has(word) ? 2 : 1
      continue
    }
    const letters = word.slice(1)
    const valueAt = [...letters].findIndex(letter => PRIVILEGE_VALUE_LETTERS.includes(letter))
    i += valueAt !== -1 && valueAt === letters.length - 1 ? 2 : 1
  }
  return argv.slice(i)
}

function decodeAnsiCString(text: string): string | null {
  const match = text.match(/^\$'([\s\S]*)'$/)
  if (!match) return null
  const body = match[1] as string
  const simple: Record<string, string> = { a: '\x07', b: '\b', e: '\x1b', E: '\x1b', f: '\f', n: '\n', r: '\r', t: '\t', v: '\v', '\\': '\\', "'": "'", '"': '"', '?': '?' }
  let out = ''
  for (let i = 0; i < body.length; i++) {
    const char = body[i] as string
    if (char !== '\\') {
      out += char
      continue
    }
    const next = body[++i]
    if (next === undefined) return null
    if (next in simple) {
      out += simple[next]
      continue
    }
    const digits = next === 'x' ? body.slice(i + 1).match(/^[0-9A-Fa-f]{1,2}/) : next === 'u' ? body.slice(i + 1).match(/^[0-9A-Fa-f]{1,4}/) : next === 'U' ? body.slice(i + 1).match(/^[0-9A-Fa-f]{1,8}/) : null
    if (digits) {
      out += String.fromCodePoint(parseInt(digits[0], 16))
      i += digits[0].length
      continue
    }
    const octal = body.slice(i).match(/^[0-7]{1,3}/)
    if (!octal) return null
    out += String.fromCharCode(parseInt(octal[0], 8))
    i += octal[0].length - 1
  }
  return out
}

function extractEvalScript(command: SimpleCommand): string | null {
  if (command.argv[0] !== 'eval' || command.argv.length < 2 || command.globOperand) return null
  return command.argv.slice(1).join(' ')
}

const XARGS_VALUE_SHORTS = 'adEIJLnPs'
const XARGS_VALUE_LONGS: ReadonlySet<string> = new Set([
  '--arg-file',
  '--delimiter',
  '--eof',
  '--replace',
  '--max-lines',
  '--max-args',
  '--max-procs',
  '--max-chars',
  '--process-slot-var',
])
const FIND_EXEC_FLAGS: ReadonlySet<string> = new Set(['-exec', '-execdir', '-ok', '-okdir'])

function unwrapCommandBuiltin(argv: string[]): string[] | null {
  let i = 1
  while (i < argv.length) {
    const word = argv[i] as string
    if (word === '--') {
      i++
      break
    }
    if (!word.startsWith('-') || word === '-') break
    if (word.startsWith('--')) return null
    if (word.includes('v') || word.includes('V')) return null
    if (/^-p+$/.test(word)) {
      i++
      continue
    }
    return null
  }
  return i < argv.length ? argv.slice(i) : null
}

function unwrapExecBuiltin(argv: string[]): string[] | null {
  let i = 1
  while (i < argv.length) {
    const word = argv[i] as string
    if (word === '--') {
      i++
      break
    }
    if (!word.startsWith('-') || word === '-') break
    if (word === '-a') {
      i += 2
      continue
    }
    if (/^-[cl]+$/.test(word)) {
      i++
      continue
    }
    if (/^-[cl]*a/.test(word)) {
      i += word.endsWith('a') ? 2 : 1
      continue
    }
    return null
  }
  return i < argv.length ? argv.slice(i) : null
}

function unwrapXargs(argv: string[]): string[] | null {
  let i = 1
  while (i < argv.length) {
    const word = argv[i] as string
    if (word === '--') {
      i++
      break
    }
    if (!word.startsWith('-') || word === '-') break
    if (word.startsWith('--')) {
      if (word.includes('=')) {
        i++
      } else if (XARGS_VALUE_LONGS.has(word)) {
        i += 2
      } else {
        i++
      }
      continue
    }
    let tookNext = false
    for (let k = 1; k < word.length; k++) {
      const ch = word[k] as string
      if (XARGS_VALUE_SHORTS.includes(ch)) {
        if (k === word.length - 1) tookNext = true
        break
      }
    }
    i += tookNext ? 2 : 1
  }
  return i < argv.length ? argv.slice(i) : null
}

function unwrapFindExecs(argv: string[]): string[][] {
  const results: string[][] = []
  for (let i = 1; i < argv.length; i++) {
    if (!FIND_EXEC_FLAGS.has(argv[i] as string)) continue
    const inner: string[] = []
    for (let j = i + 1; j < argv.length; j++) {
      const token = argv[j] as string
      if (token === ';' || token === '+') {
        i = j
        break
      }
      inner.push(token)
    }
    if (inner.length > 0) results.push(inner)
  }
  return results
}

function restrictedCommandCandidates(command: SimpleCommand, depth = 0): string[] {
  const candidates = new Set<string>()
  const addText = (text: string): void => {
    const trimmed = text.trim()
    if (trimmed !== '') candidates.add(trimmed)
  }
  addText(command.text)

  const seenArgv = new Set<string>()
  const queue: string[][] = []
  const enqueue = (argv: string[]): void => {
    if (argv.length === 0) return
    const text = shellCommandText(argv)
    if (seenArgv.has(text)) return
    seenArgv.add(text)
    addText(text)
    queue.push(argv)
  }

  enqueue(command.argv)

  while (queue.length > 0) {
    const argv = queue.shift() as string[]
    const head = argv[0] as string
    const normalizedHead = head.replace(/\\/g, '/')
    const name = posixPath.basename(normalizedHead)
    if (name !== head && name !== '') {
      enqueue([name, ...argv.slice(1)])
    }

    const peeled = peelWrappers(argv)
    if (Array.isArray(peeled) && peeled.length > 0) {
      enqueue(peeled)
    }

    if (name === 'time') {
      let i = 1
      while (i < argv.length && (argv[i] === '-p' || argv[i] === '--')) {
        const stop = argv[i] === '--'
        i++
        if (stop) break
      }
      if (i < argv.length) enqueue(argv.slice(i))
    } else if (name === 'sudo' || name === 'doas') {
      const target = privilegeTarget(argv)
      if (target.length > 0) enqueue(target)
    } else if (name === 'busybox') {
      if (argv.length > 1) enqueue(argv.slice(1))
    } else if (name === 'builtin') {
      const rest = argv[1] === '--' ? argv.slice(2) : argv.slice(1)
      if (rest.length > 0) enqueue(rest)
    } else if (name === 'command') {
      const target = unwrapCommandBuiltin(argv)
      if (target !== null) enqueue(target)
    } else if (name === 'exec') {
      const target = unwrapExecBuiltin(argv)
      if (target !== null) enqueue(target)
    } else if (name === 'xargs') {
      const target = unwrapXargs(argv)
      if (target !== null) enqueue(target)
    } else if (name === 'git') {
      const at = gitSubcommandIndex(argv.slice(1))
      if (at > 0 && at + 1 < argv.length) {
        enqueue(['git', ...argv.slice(at + 1)])
      }
    } else if (name === 'find') {
      for (const inner of unwrapFindExecs(argv)) {
        enqueue(inner)
      }
    }

    if (depth < SHELL_C_MAX_DEPTH) {
      const synthetic: SimpleCommand =
        argv === command.argv ? command : { ...command, argv, text: shellCommandText(argv) }
      const scripts = [extractShellCScript(synthetic), extractEvalScript(synthetic)].filter(
        (script): script is string => script !== null,
      )
      for (const script of scripts) {
        addText(script)
        for (const piece of pinnedCommandAnalysis.splitCommand(script)) {
          addText(piece)
        }
        const inner = preparedSecurityParse(script)
        if (inner.kind === 'simple') {
          for (const sub of inner.commands) {
            for (const subCandidate of restrictedCommandCandidates(sub, depth + 1)) {
              addText(subCandidate)
            }
          }
        }
      }
    }
  }

  return [...candidates]
}

function optionValues(args: string[], short: string, longs: readonly string[]): string[] {
  const values: string[] = []
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string
    const long = longs.find(name => arg === name || arg.startsWith(`${name}=`))
    if (long !== undefined) {
      const value = arg === long ? args[++i] : arg.slice(long.length + 1)
      if (value !== undefined) values.push(value)
      continue
    }
    if (!arg.startsWith('-') || arg.startsWith('--')) continue
    const at = [...arg].findIndex((letter, index) => index > 0 && short.includes(letter))
    if (at === -1) continue
    const value = at === arg.length - 1 ? args[++i] : arg.slice(at + 1)
    if (value !== undefined) values.push(value)
  }
  return values
}

function optionNamedWrites(words: string[]): string[] {
  const peeled = peelWrappers(words)
  const argv = Array.isArray(peeled) ? peeled : words
  const name = posixPath.basename(argv[0] ?? '')
  const args = argv.slice(1)
  if (name === 'curl') return optionValues(args, 'oDc', ['--output', '--output-dir', '--dump-header', '--cookie-jar', '--trace', '--trace-ascii', '--stderr'])
  if (name === 'wget') return optionValues(args, 'OPo', ['--output-document', '--directory-prefix', '--output-file'])
  if (name === 'unzip') return optionValues(args, 'd', [])
  if (name === 'tar' || name === 'bsdtar' || name === 'gtar') {
    const extracts = args.some(arg => arg === '--extract' || arg === '--get' || (/^-?[A-Za-z]+$/.test(arg) && !arg.startsWith('--') && arg.includes('x')))
    return extracts ? optionValues(args, 'C', ['--directory', '--cd']) : []
  }
  if (name === 'ssh-keygen') return args.some(arg => /^-[A-Za-z]*[lLyBFH]/.test(arg)) ? [] : optionValues(args, 'f', [])
  if (name === 'git') {
    const at = gitSubcommandIndex(args)
    if (args[at] !== 'config') return []
    const rest = args.slice(at + 1)
    const reads = rest.some(arg => ['--get', '--get-all', '--get-regexp', '--get-urlmatch', '--list', '-l', '--show-origin', '--show-scope'].includes(arg))
    return reads ? [] : optionValues(rest, 'f', ['--file'])
  }
  return []
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
