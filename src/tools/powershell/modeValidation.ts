import type { ToolPermissionContext } from '../kit/tool.js'
import type {
  PermissionResult,
  PermissionDecisionReason,
} from '../../permissions/rules/permissionResult.js'
import {
  deriveSecurityFlags,
  getPipelineSegments,
  isPowerShellParameter,
  type ParsedPowerShellCommand,
  type ParsedCommandElement,
} from '../../permissions/rules/decision/commandAnalysis.js'
import { argumentTypeAt } from '../../platform/shell/powershell/parser.js'
import { modeBypassesPermissions } from '../../permissions/rules/permissionMode.js'
import {
  resolveToCanonical,
  isCwdChangingCmdlet,
  isSafeOutputCommand,
  isAllowlistedPipelineTail,
  argLeaksValue,
} from './readOnlyValidation.js'

const PS_DASH = /[-–—―]/

const IMPLEMENT_MODE_WRITE = new Set(['set-content', 'add-content', 'remove-item', 'clear-content'])

const COMPLEX_COLON = /[$(@{[]/

function checkCommandInImplementMode(
  cmd: ParsedCommandElement,
  isDirect: boolean,
  originalCommand: string,
): PermissionResult | null {
  if (
    !cmd.name &&
    cmd.elementType !== 'CommandAst' &&
    cmd.elementType !== 'command' &&
    cmd.nameType !== 'cmdlet' &&
    cmd.nameType !== 'application'
  ) {
    return pass(`A non-command element (${cmd.elementType}) requires approval.`)
  }
  if (cmd.nameType === 'application') {
    return pass(`The command ${cmd.name} resolves as a file path.`)
  }
  if (isDirect) {
    for (let i = 0; i < cmd.args.length; i++) {
      const arg = cmd.args[i]!
      const argType = argumentTypeAt(cmd, i)
      if (argType !== 'StringConstant' && argType !== 'Parameter') {
        return pass('A variable path cannot be statically resolved.')
      }
      if (isPowerShellParameter(arg, argType)) {
        const colon = arg.indexOf(':', 1)
        if (colon !== -1 && COMPLEX_COLON.test(arg.slice(colon + 1))) {
          return pass('An unvalidatable colon-bound expression requires approval.')
        }
      }
    }
  }
  if (isSafeOutputCommand(cmd.name)) return null
  if (isAllowlistedPipelineTail(cmd, originalCommand)) return null
  const canonical = resolveToCanonical(cmd.name)
  if (!IMPLEMENT_MODE_WRITE.has(canonical)) {
    return pass(`The command ${cmd.name} is not an auto-allowed writer.`)
  }
  if (argLeaksValue(originalCommand, cmd)) {
    return pass('The command arguments cannot be statically validated.')
  }
  return null
}

export function checkPermissionMode(
  input: { command: string },
  parsed: ParsedPowerShellCommand,
  toolPermissionContext: ToolPermissionContext,
): PermissionResult {
  const { mode } = toolPermissionContext
  if (modeBypassesPermissions(mode) || mode === 'dontAsk') {
    return pass('Bypass-posture or never-ask mode handles this command.')
  }
  if (mode !== 'implement') {
    return pass('Not implement mode.')
  }
  if (!parsed.valid) {
    return pass('Unparseable command cannot be auto-allowed.')
  }
  const flags = deriveSecurityFlags(parsed)
  if (
    flags.hasScriptBlocks ||
    flags.hasSubExpressions ||
    flags.hasExpandableStrings ||
    flags.hasMemberInvocations ||
    flags.hasAssignments ||
    flags.hasSplatting ||
    flags.hasStopParsing
  ) {
    return pass('The command uses constructs that require approval.')
  }
  const segments = getPipelineSegments(parsed)
  if (segments.length === 0) {
    return pass('Nothing to check.')
  }

  const allCommands: ParsedCommandElement[] = []
  for (const segment of segments) {
    for (const cmd of segment.commands) allCommands.push(cmd)
    for (const cmd of segment.nestedCommands) allCommands.push(cmd)
  }
  if (allCommands.length === 0) {
    return pass('Nothing to check.')
  }

  if (allCommands.length > 1) {
    const hasCwdChange = allCommands.some(cmd => isCwdChangingCmdlet(cmd.name))
    const hasImplementModeWrite = allCommands.some(cmd => IMPLEMENT_MODE_WRITE.has(resolveToCanonical(cmd.name)))
    if (hasCwdChange && hasImplementModeWrite) {
      return pass('A compound changing the working directory and writing cannot use a stale working directory.')
    }
    if (allCommands.some(cmd => isSymlinkCreatingCommand(cmd))) {
      return pass('Path validation cannot follow just-created filesystem links.')
    }
  }
  for (const segment of segments) {
    for (const cmd of segment.commands) {
      const verdict = checkCommandInImplementMode(cmd, true, input.command)
      if (verdict) return verdict
    }
    for (const cmd of segment.nestedCommands) {
      const verdict = checkCommandInImplementMode(cmd, false, input.command)
      if (verdict) return verdict
    }
  }

  const decisionReason: PermissionDecisionReason = { type: 'mode', mode: 'implement' }
  return { behavior: 'allow', updatedInput: input, decisionReason }
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
