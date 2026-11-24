import type { ToolUseContext, ToolPermissionContext } from '../kit/tool.js'
import type {
  PermissionResult,
  PermissionDecisionReason,
} from '../../permissions/rules/permissionResult.js'
import type { ShellPermissionRule } from '../../permissions/rules/shellRuleMatching.js'
import {
  parsePermissionRule,
  matchWildcardPattern,
  suggestionForExactCommand,
} from '../../permissions/rules/shellRuleMatching.js'
import { getRuleByContentsForToolName } from '../../permissions/rules/decision/rules.js'
import { createPermissionRequestMessage } from '../../permissions/rules/decision/requestMessage.js'
import { ruleSentence } from '../../permissions/rules/ruleReason.js'
import {
  getPipelineSegments,
  getAllCommands,
  type ParsedPowerShellCommand,
  type ParsedCommandElement,
} from '../../permissions/rules/decision/commandAnalysis.js'
import { pinnedCommandAnalysis } from '../../permissions/rules/decision/commandAnalysis.js'
import { uncPathRisk, uncPathMessage, type QuotedScript } from '../../permissions/rules/uncPath.js'
import { scriptArgumentIndexes } from '../shell/pathValidation.js'
import { containsWindowsDevicePath, WINDOWS_DEVICE_PATH_MESSAGE } from '../../permissions/rules/windowsPath.js'
import { powershellCommandIsSafe } from './powershellSecurity.js'
import {
  isReadOnlyCommand,
  isProvablySafeStatement,
  isAllowlistedCommand,
  isSafeOutputCommand,
  isCwdChangingCmdlet,
  resolveToCanonical,
  argLeaksValue,
} from './readOnlyValidation.js'
import { checkPathConstraints, checkPowerShellCwd, isDangerousRemovalRawPath, dangerousRemovalDeny } from './pathValidation.js'
import { checkPermissionMode, isSymlinkCreatingCommand } from './modeValidation.js'
import { isGitInternalPathPS, isDotGitPathPS } from './gitSafety.js'
import { isCurrentDirectoryBareGitRepo } from '../../platform/git/git.js'
import { resolveShellCwd } from '../../platform/shell/shellExec.js'
import { hiddenCommandCharacterReason } from '../../platform/text/unicodeSanitization.js'
import { credentialUploadReason } from '../../permissions/rules/commandContent.js'
import { getDestructiveCommandWarning } from '../../permissions/rules/shell-commands/destructiveCommandWarning.js'
import { shellCredentialWritePath, shellMercurySecretPath, shellSelfProtectionReason } from '../../permissions/rules/shellProtectedPaths.js'
import { credentialStoreWriteRefusal } from '../../permissions/rules/filesystem.js'

const TOOL_NAME = 'PowerShell'

function stripModule(name: string): string {
  return pinnedCommandAnalysis.stripModulePrefix(name)
}

function matchRuleContent(parsedRule: ShellPermissionRule, candidate: string, mode: 'exact' | 'prefix'): boolean {
  if (parsedRule.type === 'exact') {
    return parsedRule.command.toLowerCase() === candidate.toLowerCase()
  }
  return mode === 'prefix' && matchWildcardPattern(parsedRule.pattern, candidate, true)
}

function matchRules(
  command: string,
  context: ToolPermissionContext,
  behavior: 'deny' | 'ask' | 'allow',
  mode: 'exact' | 'prefix',
): string | null {
  const rules = getRuleByContentsForToolName(context, TOOL_NAME, behavior)
  if (rules.size === 0) return null
  const trimmed = command.trim()
  const canonicalCmd = canonicaliseRuleFirstToken(trimmed)
  const candidates = canonicalCmd.toLowerCase() === trimmed.toLowerCase() ? [trimmed] : [trimmed, canonicalCmd]
  const canonicaliseRule = behavior === 'deny' || behavior === 'ask'

  for (const ruleContent of rules.keys()) {
    const parsedRule = parsePermissionRule(ruleContent)
    for (const candidate of candidates) {
      if (matchRuleContent(parsedRule, candidate, mode)) return ruleContent
    }
    if (canonicaliseRule) {
      const canonRuleContent = canonicaliseRuleFirstToken(ruleContent)
      if (canonRuleContent.toLowerCase() !== ruleContent.toLowerCase()) {
        const canonParsedRule = parsePermissionRule(canonRuleContent)
        for (const candidate of candidates) {
          if (matchRuleContent(canonParsedRule, candidate, mode)) return ruleContent
        }
      }
    }
  }
  return null
}

function canonicaliseRuleFirstToken(ruleContent: string): string {
  const match = ruleContent.match(/^(\S+)(\s+)([\s\S]*)$/)
  if (!match) return resolveToCanonical(stripModule(ruleContent))
  return `${resolveToCanonical(stripModule(match[1] as string))} ${(match[3] as string).replace(/\s+/g, ' ')}`
}

function ruleReason(context: ToolPermissionContext, ruleContent: string, behavior: 'deny' | 'ask' | 'allow'): PermissionDecisionReason {
  const rule = getRuleByContentsForToolName(context, TOOL_NAME, behavior).get(ruleContent)
  return { type: 'rule', rule: rule ?? { source: 'localSettings', ruleBehavior: behavior, ruleValue: { toolName: TOOL_NAME, ruleContent } } }
}

function ruledVerdict(context: ToolPermissionContext, subject: string, ruleContent: string, behavior: 'deny' | 'ask'): PermissionResult {
  const rule = getRuleByContentsForToolName(context, TOOL_NAME, behavior).get(ruleContent)
    ?? { source: 'localSettings' as const, ruleBehavior: behavior, ruleValue: { toolName: TOOL_NAME, ruleContent } }
  return { behavior, message: ruleSentence(subject, behavior, rule), decisionReason: { type: 'rule', rule } }
}

function exactSuggestions(command: string): ReturnType<typeof suggestionForExactCommand> {
  if (command.includes('\n') || command.includes('*')) return []
  return suggestionForExactCommand(TOOL_NAME, command)
}

function powershellToolCheckExactMatchPermission(input: { command: string }, toolPermissionContext: ToolPermissionContext): PermissionResult {
  const command = input.command.trim()
  const deny = matchRules(command, toolPermissionContext, 'deny', 'exact')
  if (deny) return ruledVerdict(toolPermissionContext, command, deny, 'deny')
  const ask = matchRules(command, toolPermissionContext, 'ask', 'exact')
  if (ask) return ruledVerdict(toolPermissionContext, command, ask, 'ask')
  const allow = matchRules(command, toolPermissionContext, 'allow', 'exact')
  if (allow) return { behavior: 'allow', updatedInput: input, decisionReason: ruleReason(toolPermissionContext, allow, 'allow') }
  return { behavior: 'passthrough', message: `${command} requires approval.`, suggestions: exactSuggestions(command) }
}

export function powershellToolCheckPermission(input: { command: string }, toolPermissionContext: ToolPermissionContext): PermissionResult {
  const exact = powershellToolCheckExactMatchPermission(input, toolPermissionContext)
  if (exact.behavior === 'deny' || exact.behavior === 'ask') return exact
  const command = input.command.trim()
  const deny = matchRules(command, toolPermissionContext, 'deny', 'prefix')
  if (deny) return ruledVerdict(toolPermissionContext, command, deny, 'deny')
  const ask = matchRules(command, toolPermissionContext, 'ask', 'prefix')
  if (ask) return ruledVerdict(toolPermissionContext, command, ask, 'ask')
  if (exact.behavior === 'allow') return exact
  const allow = matchRules(command, toolPermissionContext, 'allow', 'prefix')
  if (allow) return { behavior: 'allow', updatedInput: input, decisionReason: ruleReason(toolPermissionContext, allow, 'allow') }
  return { behavior: 'passthrough', message: `${command} requires approval.`, suggestions: exactSuggestions(command) }
}


const GIT_WRITER = new Set(['new-item', 'set-content', 'add-content', 'out-file', 'copy-item', 'move-item', 'rename-item', 'expand-archive', 'invoke-webrequest', 'invoke-restmethod', 'tee-object', 'export-csv', 'export-clixml'])
const ARCHIVE_EXTRACTORS = new Set(['tar', 'bsdtar', 'unzip', '7z', '7za', 'gzip', 'gunzip', 'tar.exe', 'bsdtar.exe', 'unzip.exe', '7z.exe', '7za.exe', 'gzip.exe', 'gunzip.exe', 'expand-archive'])

export async function powershellToolHasPermission(
  input: { command: string; timeout?: number; cwd?: string },
  context: ToolUseContext,
): Promise<PermissionResult> {
  const toolPermissionContext = context.getAppState().toolPermissionContext
  const effectiveCwd = resolveShellCwd(input.cwd)
  const resolvedInput = input.cwd === undefined ? input : { ...input, cwd: effectiveCwd }

  const verdict = await decidePowerShellPermission(resolvedInput, effectiveCwd, toolPermissionContext)
  if (verdict.behavior === 'deny') return verdict

  if (input.cwd !== undefined) {
    const cwdVerdict = checkPowerShellCwd(effectiveCwd, toolPermissionContext)
    if (cwdVerdict) return cwdVerdict
  }

  if (verdict.behavior === 'allow') {
    return { ...verdict, updatedInput: resolvedInput }
  }
  return verdict
}

async function decidePowerShellPermission(
  input: { command: string; timeout?: number; cwd?: string },
  effectiveCwd: string,
  context: ToolPermissionContext,
): Promise<PermissionResult> {
  const hiddenReason = hiddenCommandCharacterReason(input.command.replace(/\r\n/g, '\n'))
  if (hiddenReason) {
    return { behavior: 'deny', message: hiddenReason, decisionReason: { type: 'safetyCheck', reason: hiddenReason, operatorOnly: true } }
  }

  const trimmed = input.command.trim()
  const selfProtect = await shellSelfProtectionReason(trimmed, true, effectiveCwd)
  if (selfProtect) {
    return { behavior: 'deny', message: selfProtect, decisionReason: other(selfProtect) }
  }

  if (trimmed === '') {
    return { behavior: 'allow', updatedInput: input, decisionReason: other('Nothing to run.') }
  }

  const parsed = await pinnedCommandAnalysis.parsePowerShellCommand(trimmed)

  const exact = powershellToolCheckExactMatchPermission({ command: trimmed }, context)
  if (exact.behavior === 'deny') return exact

  const prefixDeny = matchRules(trimmed, context, 'deny', 'prefix')
  if (prefixDeny) return ruledVerdict(context, trimmed, prefixDeny, 'deny')

  const secretPath = await shellMercurySecretPath(trimmed, true, effectiveCwd)
  if (secretPath) {
    const msg = `Reading ${secretPath} is refused: it holds Mercury's own credentials; use the product's sign-in and account surfaces instead.`
    return { behavior: 'deny', message: msg, decisionReason: other(msg) }
  }

  const uploadReason = credentialUploadReason(trimmed)
  const destructiveReason = uploadReason ? null : getDestructiveCommandWarning(trimmed)
  const deferredReason = uploadReason ?? destructiveReason
  let slot: PermissionResult | null = deferredReason
    ? {
        behavior: 'ask',
        message: deferredReason,
        decisionReason: { type: 'safetyCheck', reason: deferredReason, operatorOnly: true },
      }
    : null

  const credWrite = await shellCredentialWritePath(trimmed, true, effectiveCwd)
  if (credWrite) {
    const refusal = credentialStoreWriteRefusal(credWrite, effectiveCwd, context)
    if (refusal) {
      return { behavior: 'deny', message: refusal, decisionReason: other(refusal) }
    }
  }

  const prefixAsk = matchRules(trimmed, context, 'ask', 'prefix')
  if (prefixAsk) slot = ruledVerdict(context, trimmed, prefixAsk, 'ask')

  const exactAllowRule = matchRules(trimmed, context, 'allow', 'exact') !== null
  const remoteUnc = uncPathRisk(trimmed, { quotedScripts: quotedScriptsIn(parsed, trimmed) })
  if (remoteUnc.risky && slot === null && !exactAllowRule) {
    const message = uncPathMessage(trimmed, remoteUnc)
    slot = { behavior: 'ask', message, decisionReason: { type: 'safetyCheck', reason: message, operatorOnly: true } }
  }

  if (slot === null && containsWindowsDevicePath(trimmed)) {
    slot = { behavior: 'ask', message: WINDOWS_DEVICE_PATH_MESSAGE }
  }

  if (!parsed.valid) {
    if (slot === null && exact.behavior === 'allow') {
      const firstWord = trimmed.split(/\s+/)[0] ?? ''
      if (pinnedCommandAnalysis.classifyCommandName(firstWord) !== 'application') {
        return exact
      }
    }
    const fragDeny = fragmentDenyScan(trimmed, context)
    if (fragDeny) return fragDeny
    if (slot) return slot
    const errMsg = parsed.errors[0]?.message ?? 'unknown error'
    return { behavior: 'ask', message: `The command has malformed syntax that cannot be parsed: ${errMsg}` }
  }

  const allCommands = getAllCommands(parsed)
  const compound = allCommands.length > 1
  const hasCd = compound && allCommands.some(cmd => isCwdChangingCmdlet(cmd.name))
  const hasSymlinkCreate = compound && allCommands.some(cmd => isSymlinkCreatingCommand(cmd))

  const collected = collectValidAstVerdicts(
    input,
    trimmed,
    parsed,
    allCommands,
    effectiveCwd,
    context,
    exact,
    slot,
    exactAllowRule,
    hasCd,
  )
  const reduced = reduce(collected)
  if (reduced) return reduced

  return evaluatePerSubcommand(input, parsed, context, hasCd, hasSymlinkCreate)
}

function collectValidAstVerdicts(
  input: { command: string },
  trimmed: string,
  parsed: ParsedPowerShellCommand,
  allCommands: ParsedCommandElement[],
  effectiveCwd: string,
  context: ToolPermissionContext,
  exact: PermissionResult,
  slot: PermissionResult | null,
  exactAllowRule: boolean,
  hasCd: boolean,
): PermissionResult[] {
  const collected: PermissionResult[] = []
  const bareAsk = (message: string): void => {
    collected.push({ behavior: 'ask', message })
  }

  if (slot) collected.push(slot)

  const hasGit = allCommands.some(cmd => resolveToCanonical(cmd.name) === 'git')

  const safety = powershellCommandIsSafe(trimmed, parsed)
  if (safety.behavior === 'ask') {
    collected.push({
      behavior: 'ask',
      message: safety.message ?? 'The command carries security-relevant patterns and needs approval.',
      suggestions: exactSuggestions(trimmed),
    })
  }

  if (parsed.hasUsingStatements) {
    bareAsk('A `using` statement may load external code (a module or an assembly).')
  }

  if (parsed.hasScriptRequirements) {
    bareAsk('A `#Requires` directive may trigger module loading.')
  }

  const providerVerdict = providerUncScan(parsed, exactAllowRule)
  if (providerVerdict) collected.push(providerVerdict)

  for (const cmd of allCommands) {
    const subVerdict = subcommandRuleVerdict(cmd, context)
    if (subVerdict) collected.push(subVerdict)
  }

  if (hasCd && hasGit) {
    bareAsk('A compound that mixes a directory change with a git invocation needs approval, because the pairing is the shape of a bare-repository attack.')
  }

  if (hasGit) {
    if (isCurrentDirectoryBareGitRepo(effectiveCwd) !== false) {
      bareAsk('The current directory carries bare-repository indicators (HEAD, objects/, refs/) with no valid .git/HEAD; git may treat it as the repository and run hooks from it.')
    }
    if (gitInternalWrite(parsed, allCommands)) {
      bareAsk('The command writes into a git-internal location (HEAD, objects/, refs/, hooks/, .git/) and then runs git — a hook could be planted and executed.')
    }
    if (allCommands.some(cmd => ARCHIVE_EXTRACTORS.has(cmd.name.toLowerCase()))) {
      bareAsk('The compound unpacks an archive before running git; an archive can carry the files that make a directory look like a repository root.')
    }
  }

  if (dotGitWrite(parsed, allCommands)) {
    bareAsk('The command targets .git/; anything planted there runs at the next git operation.')
  }

  const pathVerdict = checkPathConstraints({ command: trimmed }, parsed, context, hasCd, effectiveCwd)
  if (pathVerdict.behavior !== 'passthrough') collected.push(pathVerdict)

  if (
    exact.behavior === 'allow' &&
    allCommands.length > 0 &&
    !allCommands.some(cmd => cmd.nameType === 'application') &&
    !allCommands.some(cmd => argLeaksValue(trimmed, cmd))
  ) {
    collected.push(exact)
  }

  if (isReadOnlyCommand(trimmed, parsed)) {
    collected.push({ behavior: 'allow', updatedInput: input, decisionReason: other('The whole command is read-only.') })
  }

  if (pinnedCommandAnalysis.getFileRedirections(parsed).length > 0) {
    collected.push({
      behavior: 'ask',
      message: 'The command has file redirections that could write to arbitrary paths.',
      suggestions: exactSuggestions(trimmed),
    })
  }

  const modeVerdict = checkPermissionMode({ command: trimmed }, parsed, context)
  if (modeVerdict.behavior !== 'passthrough') collected.push(modeVerdict)

  return collected
}

function evaluatePerSubcommand(
  input: { command: string },
  parsed: ParsedPowerShellCommand,
  context: ToolPermissionContext,
  hasCd: boolean,
  hasSymlinkCreate: boolean,
): PermissionResult {
  const unapproved: ParsedCommandElement[] = []
  let firstSubAsk: PermissionResult | null = null
  let hasUnsafeStatement = false

  for (const statement of getPipelineSegments(parsed)) {
    const safeStatement = isProvablySafeStatement(statement)
    if (!safeStatement) hasUnsafeStatement = true

    for (const cmd of statement.commands) {
      if (isSafeOutputCommand(cmd.name) && cmd.args.length === 0) continue

      const subText = cmd.text.trim()
      const verdict = powershellToolCheckPermission({ command: subText }, context)
      if (verdict.behavior === 'deny') return verdict
      if (verdict.behavior === 'ask') {
        firstSubAsk ??= verdict
        continue
      }

      if (
        verdict.behavior === 'allow' &&
        cmd.nameType !== 'application' &&
        !hasSymlinkCreate &&
        !argLeaksValue(input.command, cmd)
      ) {
        continue
      }

      if (safeStatement && !hasCd && !hasSymlinkCreate && isAllowlistedCommand(cmd, input.command)) {
        continue
      }

      unapproved.push(cmd)
    }
  }

  if (firstSubAsk) return firstSubAsk

  if (unapproved.length === 0 && !hasUnsafeStatement) {
    if (parsedHasScriptBlocks(parsed)) {
      const msg = 'What remains is a formatting pipeline whose script-block bodies were never inspected.'
      return { behavior: 'ask', message: msg, decisionReason: other(msg) }
    }
    return {
      behavior: 'allow',
      updatedInput: input,
      decisionReason: other('Every command in the pipeline cleared on its own.'),
    }
  }

  const suggestions = unapproved.flatMap(cmd => exactSuggestions(cmd.text.trim()))

  return {
    behavior: 'passthrough',
    message: createPermissionRequestMessage(TOOL_NAME),
    decisionReason: other('Requires approval.'),
    suggestions,
  }
}

function reduce(collected: PermissionResult[]): PermissionResult | null {
  const deny = collected.find(r => r.behavior === 'deny')
  if (deny) return deny
  const ask = collected.find(r => r.behavior === 'ask')
  if (ask) return ask
  const allow = collected.find(r => r.behavior === 'allow')
  if (allow) return allow
  return null
}

function subcommandRuleVerdict(command: ParsedCommandElement, context: ToolPermissionContext): PermissionResult | null {
  const raw = command.text.trim()
  const canonical = command.name ? `${resolveToCanonical(command.name)} ${command.args.join(' ')}`.trim() : null
  const deny = matchRules(raw, context, 'deny', 'prefix') ?? (canonical ? matchRules(canonical, context, 'deny', 'prefix') : null)
  if (deny) return ruledVerdict(context, raw, deny, 'deny')
  const ask = matchRules(raw, context, 'ask', 'prefix') ?? (canonical ? matchRules(canonical, context, 'ask', 'prefix') : null)
  if (ask) return ruledVerdict(context, raw, ask, 'ask')
  return null
}

function quotedScriptArguments(command: ParsedCommandElement): Array<{ index: number; spelling: string }> {
  return scriptArgumentIndexes(command.name.toLowerCase(), command.args).flatMap(index => {
    const value = command.args[index]
    if (value === undefined) return []
    const spelling = [`'${value.replaceAll("'", "''")}'`, `"${value}"`].find(candidate => command.text.includes(candidate))
    return spelling === undefined ? [] : [{ index, spelling }]
  })
}

function quotedScriptsIn(parsed: ParsedPowerShellCommand, text: string): QuotedScript[] {
  if (!parsed.valid) return []
  const found: QuotedScript[] = []
  for (const command of getAllCommands(parsed)) {
    const scripts = quotedScriptArguments(command)
    for (let at = text.indexOf(command.text); scripts.length > 0 && at !== -1; at = text.indexOf(command.text, at + 1)) {
      let cursor = 0
      for (const { spelling } of scripts) {
        const inside = command.text.indexOf(spelling, cursor)
        if (inside === -1) continue
        found.push({ start: at + inside + 1, end: at + inside + spelling.length - 1 })
        cursor = inside + spelling.length
      }
    }
  }
  return found
}

const PROVIDER_PREFIX = /^(?:[\w.]+\\)?(?:env|hklm|hkcu|function|alias|variable|cert|wsman|registry)(?:::|:)/i
function providerUncScan(parsed: ParsedPowerShellCommand, uncGranted: boolean): PermissionResult | null {
  for (const statement of getPipelineSegments(parsed)) {
    for (const command of [...statement.commands, ...statement.nestedCommands]) {
      const scripts = new Set(quotedScriptArguments(command).map(script => script.index))
      for (const [index, arg] of command.args.entries()) {
        let a = arg
        if (/[-–—―]/.test(a[0] ?? '')) { const colon = a.indexOf(':', 1); if (colon !== -1) a = a.slice(colon + 1) }
        a = a.replace(/`/g, '')
        if (PROVIDER_PREFIX.test(a)) return { behavior: 'ask', message: `The argument "${arg}" uses a non-filesystem provider path requiring approval.` }
        const remote = uncPathRisk(a, scripts.has(index) ? { quotedScripts: [{ start: 0, end: a.length }] } : {})
        if (remote.risky && !uncGranted) {
          const message = uncPathMessage(arg, remote)
          return { behavior: 'ask', message, decisionReason: { type: 'safetyCheck', reason: message, operatorOnly: true } }
        }
      }
    }
  }
  return null
}

function gitInternalWrite(parsed: ParsedPowerShellCommand, subcommands: ParsedCommandElement[]): boolean {
  for (const command of subcommands) {
    if (GIT_WRITER.has(resolveToCanonical(command.name))) {
      for (const arg of command.args.flatMap(a => a.split(','))) if (isGitInternalPathPS(arg)) return true
    }
    for (const redirect of command.redirections ?? []) if (isGitInternalPathPS(redirect.target)) return true
  }
  for (const redirect of pinnedCommandAnalysis.getFileRedirections(parsed)) if (isGitInternalPathPS(redirect.target)) return true
  return false
}

function dotGitWrite(parsed: ParsedPowerShellCommand, subcommands: ParsedCommandElement[]): boolean {
  for (const command of subcommands) {
    if (GIT_WRITER.has(resolveToCanonical(command.name))) {
      for (const arg of command.args.flatMap(a => a.split(','))) if (isDotGitPathPS(arg)) return true
    }
    for (const redirect of command.redirections ?? []) if (isDotGitPathPS(redirect.target)) return true
  }
  for (const redirect of pinnedCommandAnalysis.getFileRedirections(parsed)) if (isDotGitPathPS(redirect.target)) return true
  return false
}

function fragmentDenyScan(command: string, context: ToolPermissionContext): PermissionResult | null {
  const collapsed = command.replace(/`\n\s*/g, '').replace(/`/g, '')
  for (const raw of collapsed.split(/[;|\n\r{}()&]/)) {
    let fragment = raw.trim()
    if (fragment === '') continue
    fragment = fragment.replace(/^\$?\w+\s*[-+*/]?=\s*/, '').replace(/^[.&]\s+/, '')
    if (/^['"]/.test(fragment)) fragment = fragment.slice(1).replace(/['"]$/, '')
    const first = fragment.split(/\s+/)[0] ?? ''
    if (resolveToCanonical(first) === 'remove-item') {
      for (const token of fragment.split(/\s+/).slice(1)) {
        if (/^[-–—―]/.test(token)) continue
        if (isDangerousRemovalRawPath(token)) return dangerousRemovalDeny(token)
      }
    }
    const deny = matchRules(fragment, context, 'deny', 'prefix')
    if (deny) return ruledVerdict(context, command, deny, 'deny')
  }
  return null
}

function parsedHasScriptBlocks(parsed: ParsedPowerShellCommand): boolean {
  return getPipelineSegments(parsed).some(s => s.securityPatterns?.hasScriptBlock === true)
}

function other(reason: string): PermissionDecisionReason {
  return { type: 'other', reason }
}
