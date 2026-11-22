import { getEmptyToolPermissionContext, type ToolPermissionContext, type ToolUseContext } from '../../Tool.js'
import type {
  PermissionResult,
  PermissionDecisionReason,
} from '../../utils/permissions/PermissionResult.js'
import { resolveShellCwd } from '../../utils/Shell.js'
import { hiddenCommandCharacterReason } from '../../utils/sanitization.js'
import { credentialUploadReason } from '../../utils/permissions/commandContent.js'
import { refusalWithReason, ruleWords } from '../../utils/permissions/ruleReason.js'
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
import { notBuilt } from '../../pi/holes.js'

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
  return notBuilt('src/tools/BashTool/bashPermissions.ts:86')
}

export function getSimpleCommandPrefix(command: string): string | null {
  return notBuilt('src/tools/BashTool/bashPermissions.ts:95')
}

export function getFirstWordPrefix(command: string): string | null {
  return notBuilt('src/tools/BashTool/bashPermissions.ts:100')
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
  compoundHasCd?: boolean,
  astCommand?: SimpleCommand,
  shown?: string,
): PermissionResult {
  return notBuilt('src/tools/BashTool/bashPermissions.ts:170')
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

export function rewriteReadOnlyGitCommand(command: string, cwd: string, depth?: number): string {
  return notBuilt('src/tools/BashTool/bashPermissions.ts:241')
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

function contentRulesReadAsBash(context: ToolPermissionContext, toolName: string): { context: ToolPermissionContext; own: Set<string> } {
  return notBuilt('src/tools/BashTool/bashPermissions.ts:383')
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
  depth?: number,
  inheritedHasCd?: boolean,
): Promise<PermissionResult> {
  return notBuilt('src/tools/BashTool/bashPermissions.ts:467')
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

function restrictedCommandCandidates(command: SimpleCommand, depth?: number): string[] {
  return notBuilt('src/tools/BashTool/bashPermissions.ts:827')
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
