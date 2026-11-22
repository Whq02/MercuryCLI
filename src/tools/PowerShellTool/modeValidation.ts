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
import { notBuilt } from '../../pi/holes.js'

const PS_DASH = /[-–—―]/

const ACCEPT_EDITS_WRITE = new Set(['set-content', 'add-content', 'remove-item', 'clear-content'])

const COMPLEX_COLON = /[$(@{[]/

export function checkPermissionMode(
  input: { command: string },
  parsed: ParsedPowerShellCommand,
  toolPermissionContext: ToolPermissionContext,
): PermissionResult {
  return notBuilt('src/tools/PowerShellTool/modeValidation.ts:29')
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
