import type { ToolPermissionContext } from '../../Tool.js'
import type {
  PermissionResult,
  PermissionDecisionReason,
} from '../../utils/permissions/PermissionResult.js'
import {
  deriveSecurityFlags,
  getPipelineSegments,
  isPowerShellParameter,
  type ParsedPowerShellCommand,
  type ParsedCommandElement,
} from '../../utils/permissions/decision/commandAnalysis.js'
import { argumentTypeAt } from '../../utils/powershell/parser.js'
import { modeBypassesPermissions } from '../../utils/permissions/PermissionMode.js'
import {
  resolveToCanonical,
  isCwdChangingCmdlet,
  isSafeOutputCommand,
  isAllowlistedPipelineTail,
  argLeaksValue,
} from './readOnlyValidation.js'

const PS_DASH = /[-–—―]/

const ACCEPT_EDITS_WRITE = new Set(['set-content', 'add-content', 'remove-item', 'clear-content'])

const COMPLEX_COLON = /[$(@{[]/

function checkCommandInImplementMode(
  cmd: ParsedCommandElement,
  isDirect: boolean,
  originalCommand: string,
): PermissionResult | null {
  if (!cmd.name || cmd.elementType !== 'CommandAst') {
    return pass('Non-command or empty element cannot be auto-allowed in implement mode.')
  }
  if (cmd.nameType === 'application') {
    return pass(`External application "${cmd.name}" requires approval in implement mode.`)
  }
  if (isDirect) {
    for (let i = 0; i < cmd.args.length; i++) {
      const arg = cmd.args[i]!
      const argType = argumentTypeAt(cmd, i)
      if (argType !== 'StringConstant' && argType !== 'Parameter') {
        return pass(`Argument "${arg}" is not a static literal or parameter.`)
      }
      if (isPowerShellParameter(arg, argType)) {
        const colon = arg.indexOf(':', 1)
        if (colon !== -1 && COMPLEX_COLON.test(arg.slice(colon + 1))) {
          return pass(`Parameter "${arg}" has a complex colon-bound value.`)
        }
      }
    }
  }
  if (isSafeOutputCommand(cmd.name)) return null
  if (isAllowlistedPipelineTail(cmd, originalCommand)) return null
  const canonical = resolveToCanonical(cmd.name)
  if (!ACCEPT_EDITS_WRITE.has(canonical)) {
    return pass(`Command "${cmd.name}" is not auto-allowed in implement mode.`)
  }
  if (argLeaksValue(originalCommand, cmd)) {
    return pass(`Command "${cmd.name}" has an argument that may leak dynamic values.`)
  }
  return null
}

export function checkPermissionMode(
  input: { command: string },
  parsed: ParsedPowerShellCommand,
  toolPermissionContext: ToolPermissionContext,
): PermissionResult {
  const { mode } = toolPermissionContext
  if (modeBypassesPermissions(mode) || mode === 'dontAsk' || mode !== 'implement') {
    return pass(`Permission mode "${mode}" does not auto-allow this command.`)
  }
  if (!parsed.valid) {
    return pass('Command AST is not valid.')
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
    return pass('Command contains dynamic or unsafe PowerShell constructs.')
  }
  const segments = getPipelineSegments(parsed)
  if (segments.length === 0) {
    return pass('Command has no pipeline segments.')
  }

  const allCommands: ParsedCommandElement[] = []
  for (const segment of segments) {
    for (const cmd of segment.commands) allCommands.push(cmd)
    for (const cmd of segment.nestedCommands) allCommands.push(cmd)
  }
  if (allCommands.length === 0) {
    return pass('Command contains no commands.')
  }

  if (allCommands.length > 1) {
    const hasCwdChange = allCommands.some(cmd => isCwdChangingCmdlet(cmd.name))
    const hasAcceptEditsWrite = allCommands.some(cmd => ACCEPT_EDITS_WRITE.has(resolveToCanonical(cmd.name)))
    if (hasCwdChange && hasAcceptEditsWrite) {
      return pass('Compound command combines a working-directory change with file writes.')
    }
    if (allCommands.some(cmd => isSymlinkCreatingCommand(cmd))) {
      return pass('Compound command creates symlinks, junctions, or hardlinks.')
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
