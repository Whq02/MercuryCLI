import { modeBypassesPermissions } from '../../permissions/rules/permissionMode.js'
import type { PermissionResult } from '../../permissions/rules/permissionResult.js'
import type { ToolPermissionContext } from '../kit/tool.js'
import { preparedSecurityParse } from '../../permissions/rules/decision/commandAnalysis.js'
import { ownGroundCommand } from '../../permissions/rules/ownGround.js'
import { resolveShellCwd } from '../../platform/shell/shellExec.js'

const ACCEPT_EDITS_COMMANDS: ReadonlySet<string> = new Set([
  'mkdir',
  'touch',
  'rm',
  'rmdir',
  'mv',
  'cp',
  'sed',
])

export function checkPermissionMode(
  input: { command: string; cwd?: string },
  toolPermissionContext: ToolPermissionContext,
): PermissionResult<{ command: string; cwd?: string }> {
  const parsed = preparedSecurityParse(input.command)
  if (parsed.kind === 'simple' && parsed.commands.length > 0) {
    const cwd = resolveShellCwd(input.cwd)
    if (parsed.commands.every(simple => ownGroundCommand(simple, cwd))) {
      return {
        behavior: 'allow',
        updatedInput: input,
        decisionReason: { type: 'other', reason: "the run's own ground" },
      }
    }
  }

  if (modeBypassesPermissions(toolPermissionContext.mode)) {
    return { behavior: 'passthrough', message: 'Bypass-posture mode handles this command.' }
  }
  if (toolPermissionContext.mode === 'dontAsk') {
    return { behavior: 'passthrough', message: 'Never-ask mode handles this command.' }
  }

  if (parsed.kind !== 'simple') {
    return { behavior: 'passthrough', message: 'The command has no proven mode handling.' }
  }

  for (const simple of parsed.commands) {
    const commandName = simple.argv[0]
    if (!commandName) {
      return { behavior: 'passthrough', message: 'No command to evaluate for mode auto-allow.' }
    }
    if (toolPermissionContext.mode === 'implement' && ACCEPT_EDITS_COMMANDS.has(commandName)) {
      return {
        behavior: 'allow',
        updatedInput: { command: simple.text },
        decisionReason: { type: 'mode', mode: 'implement' },
      }
    }
  }

  return { behavior: 'passthrough', message: 'No mode handling was required.' }
}
