/**
 * PowerShell implement-mode auto-allow. Returns allow or passthrough only.
 * A compound that changes the namespace, creates a filesystem link, or contains
 * a non-command element never auto-allows — a later statement would resolve
 * through the changed namespace/link, and a bound variable path is unresolvable.
 */
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
import { modeBypassesPermissions } from '../../utils/permissions/PermissionMode.js'
import {
  resolveToCanonical,
  isCwdChangingCmdlet,
  isSafeOutputCommand,
  isAllowlistedPipelineTail,
  argLeaksValue,
} from './readOnlyValidation.js'

/** PowerShell dash characters. */
const PS_DASH = /[-–—―]/

/** The accept-edits write set (contract data, canonical lowercase). */
const ACCEPT_EDITS_WRITE = new Set(['set-content', 'add-content', 'remove-item', 'clear-content'])

/** Colon-value metacharacters that hide a runtime expression. */
const COMPLEX_COLON = /[$(@{[]/

/** Decide whether implement mode auto-allows this parsed command. */
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
    // Compound guards over each segment's direct command elements.
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

  // For every command in every segment (and nested commands).
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

/** Check one command; return a passthrough verdict if it blocks auto-allow, else null. */
function checkCommand(command: ParsedCommandElement, _originalCommand: string, direct: boolean): PermissionResult | null {
  if (command.elementType !== 'Command' && command.nameType !== 'cmdlet' && command.nameType !== 'application' && command.name === '') {
    return pass(`A non-command element (${command.elementType}) requires approval.`)
  }
  if (command.nameType === 'application') return pass(`The command ${command.name} resolves as a file path.`)

  if (direct) {
    // Argument element-type checks (direct commands only).
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

/** True when the command creates a filesystem link (New-Item -ItemType symboliclink/junction/hardlink). */
export function isSymlinkCreatingCommand(cmd: { name: string; args: string[] }): boolean {
  if (resolveToCanonical(cmd.name) !== 'new-item') return false
  const LINK_TYPES = new Set(['symboliclink', 'junction', 'hardlink'])
  for (let i = 0; i < cmd.args.length; i++) {
    let arg = (cmd.args[i] as string).replace(/`/g, '')
    if (!PS_DASH.test(arg[0] ?? '')) continue
    arg = '-' + arg.slice(1) // normalise the prefix
    const colon = arg.indexOf(':', 1)
    const name = colon === -1 ? arg : arg.slice(0, colon)
    // An unambiguous abbreviation of -itemtype (min -it) or -type (min -ty).
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
