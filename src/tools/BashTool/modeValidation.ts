import { modeBypassesPermissions, permissionModeTitle } from '../../utils/permissions/PermissionMode.js'
import type { PermissionResult } from '../../utils/permissions/PermissionResult.js'
import type { ToolPermissionContext } from '../../Tool.js'
import { pinnedCommandAnalysis } from '../../utils/permissions/decision/commandAnalysis.js'
import { EXIT_PLAN_MODE_TOOL_NAME } from '../ExitPlanModeTool/constants.js'
import { findMutatingSegment } from './strategyMutation.js'

export function strategyShellRefusal(segment: string, reason: string): string {
  return `${permissionModeTitle('strategy')} refused running \`${segment}\`: ${reason}. The user wants a plan before any execution — until they approve one, nothing may change: no file edits, no config changes, no commits. Present the plan with ${EXIT_PLAN_MODE_TOOL_NAME}; the command can run once the plan is approved.`
}

export function checkStrategyShellRefusal<I extends { command: string }>(
  input: I,
  toolPermissionContext: ToolPermissionContext,
): PermissionResult<I> | null {
  if (toolPermissionContext.mode !== 'strategy') return null
  const finding = findMutatingSegment(input.command)
  if (finding === null) return null
  return {
    behavior: 'deny',
    message: strategyShellRefusal(finding.segment, finding.reason),
    decisionReason: { type: 'mode', mode: 'strategy' },
  }
}

const ACCEPT_EDITS_COMMANDS: ReadonlySet<string> = new Set([
  'mkdir',
  'touch',
  'rm',
  'rmdir',
  'mv',
  'cp',
  'sed',
])

export function checkPermissionMode<I extends { command: string }>(
  input: I,
  toolPermissionContext: ToolPermissionContext,
): PermissionResult<I> {
  if (modeBypassesPermissions(toolPermissionContext.mode)) {
    return { behavior: 'passthrough', message: 'Bypass-posture mode handles this command.' }
  }
  if (toolPermissionContext.mode === 'dontAsk') {
    return { behavior: 'passthrough', message: 'Never-ask mode handles this command.' }
  }

  const subcommands = pinnedCommandAnalysis.splitCommand(input.command)
  for (const raw of subcommands) {
    const subcommand = raw.trim()
    const base = subcommand.split(/\s+/)[0]
    if (!base) {
      return { behavior: 'passthrough', message: 'No command to evaluate for mode auto-allow.' }
    }
    if (toolPermissionContext.mode === 'implement' && ACCEPT_EDITS_COMMANDS.has(base)) {
      return {
        behavior: 'allow',
        updatedInput: { command: subcommand } as unknown as I,
        decisionReason: { type: 'mode', mode: 'implement' },
      }
    }
  }

  return { behavior: 'passthrough', message: 'No mode handling was required.' }
}
