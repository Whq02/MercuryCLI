import type { ToolPermissionContext } from '../../Tool.js'
import type {
  PermissionResult,
  PermissionDecisionReason,
} from '../../utils/permissions/PermissionResult.js'
import {
  deriveSecurityFlags,
  getPipelineSegments,
  isPowerShellParameter,
  pinnedCommandAnalysis,
  type ParsedPowerShellCommand,
  type ParsedCommandElement,
} from '../../utils/permissions/decision/commandAnalysis.js'
import { modeBypassesPermissions } from '../../utils/permissions/PermissionMode.js'
import { strategyShellRefusal } from '../BashTool/modeValidation.js'
import { judgeCommandWords, type MutationFinding } from '../BashTool/strategyMutation.js'
import {
  resolveToCanonical,
  isCwdChangingCmdlet,
  isSafeOutputCommand,
  isAllowlistedPipelineTail,
  argLeaksValue,
} from './readOnlyValidation.js'

export const POWERSHELL_MUTATING_COMMANDS: Readonly<Record<string, string>> = {
  'remove-item': 'Remove-Item removes files',
  'move-item': 'Move-Item moves or renames files',
  'rename-item': 'Rename-Item renames files',
  'copy-item': 'Copy-Item writes its destination',
  'new-item': 'New-Item creates files, directories or links',
  'set-content': 'Set-Content rewrites a file',
  'add-content': 'Add-Content appends to a file',
  'clear-content': 'Clear-Content empties a file',
  'out-file': 'Out-File writes a file',
  'export-csv': 'Export-Csv writes a file',
  'export-clixml': 'Export-Clixml writes a file',
  'set-item': 'Set-Item rewrites an item',
  'clear-item': 'Clear-Item empties an item',
  'set-itemproperty': 'Set-ItemProperty rewrites item properties',
  'new-itemproperty': 'New-ItemProperty creates item properties',
  'remove-itemproperty': 'Remove-ItemProperty removes item properties',
  'rename-itemproperty': 'Rename-ItemProperty renames item properties',
  'clear-itemproperty': 'Clear-ItemProperty empties item properties',
  'expand-archive': 'Expand-Archive unpacks files into its directory',
  'compress-archive': 'Compress-Archive writes an archive file',
  'set-acl': 'Set-Acl changes access lists',
}

const SHELL_APPLICATIONS: ReadonlySet<string> = new Set(['git', 'npm', 'pnpm', 'yarn', 'bun'])
const OUT_FILE_PARAMETER = /^[-–—―]outfile(?::|$)/i
const VARIABLE_PARAMETER = /^[-–—―]var(?:iable)?(?::|$)/i

function judgePowerShellCommand(command: ParsedCommandElement): MutationFinding | null {
  const canonical = resolveToCanonical(command.name)
  const segment = command.text.trim()
  const always = POWERSHELL_MUTATING_COMMANDS[canonical]
  if (always !== undefined) return { segment, reason: always }
  if (canonical === 'tee-object') {
    return command.args.some(arg => VARIABLE_PARAMETER.test(arg)) ? null : { segment, reason: 'Tee-Object writes its file' }
  }
  if (canonical === 'invoke-webrequest' || canonical === 'invoke-restmethod') {
    return command.args.some(arg => OUT_FILE_PARAMETER.test(arg)) ? { segment, reason: `${command.name} -OutFile writes a file` } : null
  }
  if (SHELL_APPLICATIONS.has(canonical)) return judgeCommandWords([canonical, ...command.args], segment)
  return null
}

export function findMutatingPowerShellCommand(parsed: ParsedPowerShellCommand): MutationFinding | null {
  if (!parsed.valid) return null
  for (const statement of getPipelineSegments(parsed)) {
    for (const command of [...statement.commands, ...statement.nestedCommands]) {
      const finding = judgePowerShellCommand(command)
      if (finding !== null) return finding
    }
  }
  const redirection = pinnedCommandAnalysis.getFileRedirections(parsed)[0]
  if (redirection === undefined) return null
  const owner = getPipelineSegments(parsed).find(
    statement =>
      statement.redirections.includes(redirection) ||
      [...statement.commands, ...statement.nestedCommands].some(command => command.redirections?.includes(redirection) === true),
  )
  return { segment: (owner?.text ?? parsed.originalCommand).trim(), reason: `a file redirection writes ${redirection.target}` }
}

export function checkStrategyShellRefusal(
  parsed: ParsedPowerShellCommand,
  toolPermissionContext: ToolPermissionContext,
): PermissionResult | null {
  if (toolPermissionContext.mode !== 'strategy') return null
  const finding = findMutatingPowerShellCommand(parsed)
  if (finding === null) return null
  return {
    behavior: 'deny',
    message: strategyShellRefusal(finding.segment, finding.reason),
    decisionReason: { type: 'mode', mode: 'strategy' } as PermissionDecisionReason,
  }
}

const PS_DASH = /[-–—―]/

const ACCEPT_EDITS_WRITE = new Set(['set-content', 'add-content', 'remove-item', 'clear-content'])

const COMPLEX_COLON = /[$(@{[]/

export function checkPermissionMode(
  input: { command: string },
  parsed: ParsedPowerShellCommand,
  toolPermissionContext: ToolPermissionContext,
): PermissionResult {
  if (modeBypassesPermissions(toolPermissionContext.mode) || toolPermissionContext.mode === 'dontAsk') {
    return pass('Bypass-posture or never-ask mode handles this command.')
  }
  if (toolPermissionContext.mode !== 'implement') return pass('Not implement mode.')
  if (!parsed.valid) return pass('Unparseable command cannot be auto-allowed.')

  const flags = deriveSecurityFlags(parsed)
  if (
    flags.hasSubExpressions || flags.hasScriptBlocks || flags.hasMemberInvocations ||
    flags.hasSplatting || flags.hasAssignments || flags.hasStopParsing || flags.hasExpandableStrings
  ) {
    return pass('The command uses constructs that require approval.')
  }

  const segments = getPipelineSegments(parsed)
  if (segments.length === 0) return pass('Nothing to check.')

  const totalCommands = segments.reduce((sum, s) => sum + s.commands.length, 0)
  if (totalCommands > 1) {
    let hasNamespaceChange = false
    let hasWrite = false
    let hasSymlink = false
    for (const statement of segments) {
      for (const command of statement.commands) {
        const canonical = resolveToCanonical(command.name)
        if (isCwdChangingCmdlet(canonical)) hasNamespaceChange = true
        if (ACCEPT_EDITS_WRITE.has(canonical)) hasWrite = true
        if (isSymlinkCreatingCommand({ name: command.name, args: command.args })) hasSymlink = true
      }
    }
    if (hasNamespaceChange && hasWrite) {
      return pass('A compound changing the working directory and writing cannot use a stale working directory.')
    }
    if (hasSymlink) {
      return pass('Path validation cannot follow just-created filesystem links.')
    }
  }

  for (const statement of segments) {
    for (const command of statement.commands) {
      const verdict = checkCommand(command, input.command, true)
      if (verdict) return verdict
    }
    for (const nested of statement.nestedCommands) {
      const verdict = checkCommand(nested, input.command, false)
      if (verdict) return verdict
    }
  }

  return {
    behavior: 'allow',
    updatedInput: input,
    decisionReason: { type: 'mode', mode: 'implement' } as PermissionDecisionReason,
  }
}

function checkCommand(command: ParsedCommandElement, _originalCommand: string, direct: boolean): PermissionResult | null {
  if (command.elementType !== 'Command' && command.nameType !== 'cmdlet' && command.nameType !== 'application' && command.name === '') {
    return pass(`A non-command element (${command.elementType}) requires approval.`)
  }
  if (command.nameType === 'application') return pass(`The command ${command.name} resolves as a file path.`)

  if (direct) {
    const types = command.elementTypes
    if (types) {
      for (let i = 0; i < command.args.length; i++) {
        const type = types[i]
        const arg = command.args[i] as string
        if (type !== 'StringConstant' && type !== 'Parameter') {
          return pass('A variable path cannot be statically resolved.')
        }
        if (type === 'Parameter' && isPowerShellParameter(arg)) {
          const colon = arg.indexOf(':', 1)
          if (colon !== -1 && COMPLEX_COLON.test(arg.slice(colon + 1))) {
            return pass('An unvalidatable colon-bound expression requires approval.')
          }
        }
      }
    }
  }

  const canonical = resolveToCanonical(command.name)
  if (isSafeOutputCommand(canonical) || isAllowlistedPipelineTail(command, _originalCommand)) return null
  if (!ACCEPT_EDITS_WRITE.has(canonical)) return pass(`The command ${command.name} is not an auto-allowed writer.`)
  if (argLeaksValue(_originalCommand, command)) return pass('The command arguments cannot be statically validated.')
  return null
}

export function isSymlinkCreatingCommand(cmd: { name: string; args: string[] }): boolean {
  if (resolveToCanonical(cmd.name) !== 'new-item') return false
  const LINK_TYPES = new Set(['symboliclink', 'junction', 'hardlink'])
  for (let i = 0; i < cmd.args.length; i++) {
    let arg = (cmd.args[i] as string).replace(/`/g, '')
    if (!PS_DASH.test(arg[0] ?? '')) continue
    arg = '-' + arg.slice(1)
    const colon = arg.indexOf(':', 1)
    const name = colon === -1 ? arg : arg.slice(0, colon)
    const isItemType = /^-it(?:e(?:m(?:t(?:y(?:p(?:e)?)?)?)?)?)?$/i.test(name)
    const isTypeAlias = /^-ty(?:p(?:e)?)?$/i.test(name)
    if (!isItemType && !isTypeAlias) continue
    let value = colon !== -1 ? arg.slice(colon + 1) : (cmd.args[i + 1] ?? '')
    value = value.replace(/`/g, '').toLowerCase()
    if (/^['"]/.test(value)) value = value.slice(1)
    if (/['"]$/.test(value)) value = value.slice(0, -1)
    if (LINK_TYPES.has(value)) return true
  }
  return false
}

function pass(message: string): PermissionResult {
  return { behavior: 'passthrough', message }
}
