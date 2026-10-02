import { modeBypassesPermissions } from '../../utils/permissions/PermissionMode.js'
import type { PermissionResult } from '../../utils/permissions/PermissionResult.js'
import type { ToolPermissionContext } from '../../Tool.js'
import { pinnedCommandAnalysis } from '../../utils/permissions/decision/commandAnalysis.js'

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
