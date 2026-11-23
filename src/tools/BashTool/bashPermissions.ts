import { entriesOf } from '../../utils/entriesOf.js'
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
import { refusalWithReason } from '../../utils/permissions/ruleReason.js'

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
        : 'the shell parser has not produced a tree; retry the command, or approve',
    )
  }
  const semantics = pinnedCommandAnalysis.checkSemantics(parsed.commands)
  if (!semantics.ok) return unprovenAsk(semantics.reason)
  if (parsed.commands.length !== 1) {
    return unprovenAsk('this entry needs one parsed command; split the command, or approve')
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

  const readOnly = checkPreparedReadOnlyConstraints(input, compoundHasCd, { ...simple, redirects: [] }, SHELL_C_MAX_DEPTH)
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
type MutableRulesBySource = Partial<Record<RuleSourceKey, string[]>>
type MutableRuleReasons = Partial<Record<RuleSourceKey, Record<string, string>>>

function contentRulesReadAsBash(context: ToolPermissionContext, toolName: string): { context: ToolPermissionContext; own: Set<string> } {
  const own = new Set<string>()
  if (toolName === TOOL_NAME) return { context, own }

  let nextReasons: MutableRuleReasons | undefined
  const ensureReasons = (): MutableRuleReasons => {
    if (nextReasons === undefined) {
      const cloned: MutableRuleReasons = {}
      if (context.ruleReasons) {
        for (const [source, map] of entriesOf(context.ruleReasons)) {
          if (map) cloned[source] = { ...map }
        }
      }
      nextReasons = cloned
    }
    return nextReasons
  }

  const projectMap = (map: RulesBySource): RulesBySource => {
    let changed = false
    const out: MutableRulesBySource = {}
    for (const [source, rules] of entriesOf(map)) {
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

async function decideBashPermission(
  input: BashInput,
  context: ToolPermissionContext,
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
    const refusal = credentialStoreWriteRefusal(protectedWrite, cwd, context)
    if (refusal !== null) return { behavior: 'deny', message: refusal, decisionReason: { type: 'other', reason: refusal } }
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
      for (const written of shellCCommands(parsed.commands).flatMap(simple => optionNamedWrites(simple.argv))) {
        if (credentialStorePath(written, cwd) === null) continue
        const refusal = credentialStoreWriteRefusal(written, cwd, context)
        if (refusal !== null) return { behavior: 'deny', message: refusal, decisionReason: { type: 'other', reason: refusal } }
      }
      if (uploadAsk !== null) return uploadAsk
      const semantic = pinnedCommandAnalysis.checkSemantics(parsed.commands)
      if (!semantic.ok) return unprovenAsk(semantic.reason)
      astCommands = parsed.commands
      compoundHasCd ||= shellCCommands(astCommands).some(simple =>
        isNormalizedCdCommand(simple.text) && !isCurrentDirectoryCommand(simple, cwd))
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
    segmentInput => decideBashPermission(segmentInput, context, depth, inheritedHasCd),
    compoundHasCd ? identityCheckers : { ...identityCheckers, isDirectoryChange: () => false },
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

  const subcommands = astCommands.map(simple => simple.text)
  const parsedSubcommands = astCommands

  if (compoundHasCd && subcommands.filter(sub => isNormalizedCdCommand(sub)).length > 1) {
    return { behavior: 'ask', message: MULTIPLE_CD_REASON, decisionReason: { type: 'other', reason: MULTIPLE_CD_REASON } }
  }

  if (compoundHasCd && subcommands.some(isNormalizedCdCommand) && subcommands.some(isNormalizedGitCommand)) {
    return { behavior: 'ask', message: CD_GIT_BARE_REPO_REASON, decisionReason: { type: 'other', reason: CD_GIT_BARE_REPO_REASON } }
  }

  const decisions = await Promise.all(subcommands.map(async (sub, i) => {
    const simple = parsedSubcommands[i]
    const outer = bashToolCheckPermission({ ...input, command: sub }, context, compoundHasCd, simple)
    const script = simple && depth < SHELL_C_MAX_DEPTH ? extractShellCScript(simple) : null
    if (script === null || outer.behavior === 'deny') return outer
    const inner = await decideBashPermission({ ...input, command: script }, context, depth + 1, compoundHasCd)
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

  const substantiveIndices = subcommands.flatMap((_, index) =>
    decisions[index]!.behavior === 'allow' && isCurrentDirectoryCommand(parsedSubcommands[index]!, cwd) ? [] : [index])
  if (substantiveIndices.length === 1) {
    const index = substantiveIndices[0]!
    const subcommand = subcommands[index] as string
    const single = await checkCommandAndSuggestRules(
      { ...input, command: subcommand },
      context,
      compoundHasCd,
      asWrittenSingle(command, subcommand, cwd),
      parsedSubcommands[index],
    )
    return single
  }

  const merged = await Promise.all(
    subcommands.map((sub, index) =>
      decisions[index]!.behavior !== 'passthrough' ? decisions[index]! : checkCommandAndSuggestRules(
        { ...input, command: sub },
        context,
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
  return context.mode === 'flow' && checkPreparedReadOnlyConstraints({ command: text }, compoundHasCd, { ...command, redirects: [] }).behavior === 'allow'
}

function astDenyCheck(input: BashInput, context: ToolPermissionContext, root: unknown): PermissionResult | null {
  const early = earlyExitDenyCheck(input, context)
  if (early) return early
  for (const node of commandSpans(root, 'lastFirst')) {
    const candidates = [node.text]
    if (/\\\r?\n/.test(node.text)) candidates.push(node.text.replace(/\\\r?\n/g, ''))
    const parsed = node.exact()
    if (parsed.kind === 'simple') candidates.push(...parsed.commands.flatMap(simple => restrictedCommandCandidates(simple)))
    const name = node.name
    if (name) {
      const named = name.word()
      if (named) candidates.push(named + name.rest)
      const decoded = name.ansiC ? decodeAnsiCString(name.text) : null
      if (decoded !== null && decoded !== '') candidates.push(decoded + name.rest)
    }
    for (const candidate of candidates) {
      const deny = matchRules(candidate, context, 'deny', 'prefix', true)
      if (deny !== null) return denyByRule(context, input.command, deny, () => matchAllRules(candidate, context, 'deny', 'prefix', true))
    }
  }
  return null
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
    const word = argv[i]!
    if (word === '--') {
      i++
      break
    }
    if (!word.startsWith('-') || word === '-') break
    const letters = shortFlagLetters(word)
    if (letters === undefined || /[vV]/.test(letters) || !/^p+$/.test(letters)) return null
    i++
  }
  return i < argv.length ? argv.slice(i) : null
}

function shortFlagLetters(word: string): string | undefined {
  return word.length > 1 && word[0] === '-' && word[1] !== '-' ? word.slice(1) : undefined
}

function unwrapExecBuiltin(argv: string[]): string[] | null {
  let i = 1
  while (i < argv.length) {
    const word = argv[i]!
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
    const word = argv[i]!
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
      const ch = word[k]!
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
    if (!FIND_EXEC_FLAGS.has(argv[i]!)) continue
    const inner: string[] = []
    for (let j = i + 1; j < argv.length; j++) {
      const token = argv[j]!
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
    const head = argv[0]!
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
      while (i < argv.length && (shortFlagLetters(argv[i]!) === 'p' || argv[i] === '--')) {
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
  }

  if (depth < SHELL_C_MAX_DEPTH) {
    const scripts = [extractShellCScript(command), extractEvalScript(command)].filter(
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
