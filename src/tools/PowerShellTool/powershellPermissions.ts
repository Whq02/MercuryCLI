import type { ToolUseContext, ToolPermissionContext } from '../../Tool.js'
import type {
  PermissionResult,
  PermissionDecisionReason,
} from '../../utils/permissions/PermissionResult.js'
import type { ShellPermissionRule } from '../../utils/permissions/shellRuleMatching.js'
import {
  parsePermissionRule,
  matchWildcardPattern,
  suggestionForExactCommand,
} from '../../utils/permissions/shellRuleMatching.js'
import { getRuleByContentsForToolName } from '../../utils/permissions/decision/rules.js'
import { createPermissionRequestMessage } from '../../utils/permissions/decision/requestMessage.js'
import { ruleSentence } from '../../utils/permissions/ruleReason.js'
import {
  getPipelineSegments,
  getAllCommands,
  type ParsedPowerShellCommand,
  type ParsedCommandElement,
} from '../../utils/permissions/decision/commandAnalysis.js'
import { pinnedCommandAnalysis } from '../../utils/permissions/decision/commandAnalysis.js'
import { uncPathRisk, uncPathMessage } from '../../utils/permissions/uncPath.js'
import { containsWindowsDevicePath, WINDOWS_DEVICE_PATH_MESSAGE } from '../../utils/permissions/windowsPath.js'
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
import { isCurrentDirectoryBareGitRepo } from '../../utils/git.js'
import { resolveShellCwd } from '../../utils/Shell.js'
import { hiddenCommandCharacterReason } from '../../utils/sanitization.js'
import { credentialUploadReason } from '../../utils/permissions/commandContent.js'
import { getDestructiveCommandWarning } from '../../utils/shell/destructiveCommandWarning.js'
import { shellCredentialWritePath, shellMercurySecretPath, shellSelfProtectionReason } from '../../utils/permissions/shellProtectedPaths.js'
import { credentialStoreWriteRefusal } from '../../utils/permissions/filesystem.js'
import { notBuilt } from '../../pi/holes.js'

const TOOL_NAME = 'PowerShell'

function stripModule(name: string): string {
  return pinnedCommandAnalysis.stripModulePrefix(name)
}

function matchRules(command: string, context: ToolPermissionContext, behavior: 'deny' | 'ask' | 'allow', mode: 'exact' | 'prefix'): string | null {
  return notBuilt('src/tools/PowerShellTool/powershellPermissions.ts:70')
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
  return notBuilt('src/tools/PowerShellTool/powershellPermissions.ts:104')
}

function powershellToolCheckExactMatchPermission(input: { command: string }, toolPermissionContext: ToolPermissionContext): PermissionResult {
  return notBuilt('src/tools/PowerShellTool/powershellPermissions.ts:109')
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
  return notBuilt('src/tools/PowerShellTool/powershellPermissions.ts:138')
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

const PROVIDER_PREFIX = /^(?:[\w.]+\\)?(?:env|hklm|hkcu|function|alias|variable|cert|wsman|registry)(?:::|:)/i
function providerUncScan(parsed: ParsedPowerShellCommand, uncGranted: boolean): PermissionResult | null {
  for (const statement of getPipelineSegments(parsed)) {
    for (const command of [...statement.commands, ...statement.nestedCommands]) {
      for (const arg of command.args) {
        let a = arg
        if (/[-–—―]/.test(a[0] ?? '')) { const colon = a.indexOf(':', 1); if (colon !== -1) a = a.slice(colon + 1) }
        a = a.replace(/`/g, '')
        if (PROVIDER_PREFIX.test(a)) return { behavior: 'ask', message: `The argument "${arg}" uses a non-filesystem provider path requiring approval.` }
        const remote = uncPathRisk(a)
        if (remote.risky && !uncGranted) {
          const message = uncPathMessage(arg, remote)
          return { behavior: 'ask', message, decisionReason: { type: 'safetyCheck', reason: message, operatorOnly: true } }
        }
      }
    }
  }
  return null
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
