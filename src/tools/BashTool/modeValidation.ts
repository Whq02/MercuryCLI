/**
 * Permission-mode auto-allow for Bash.
 *
 * In implement mode a small set of filesystem commands is auto-allowed
 * without a prompt, because the user has already opted into unattended edits.
 * The bypass-posture check goes through the ONE shared predicate that also
 * covers the autopilot mode, so autopilot can never drift from the
 * bypass posture — a prover pins that call site.
 */
import { modeBypassesPermissions } from '../../utils/permissions/PermissionMode.js'
import type { PermissionResult } from '../../utils/permissions/PermissionResult.js'
import type { ToolPermissionContext } from '../../Tool.js'
import { pinnedCommandAnalysis } from '../../utils/permissions/decision/commandAnalysis.js'

/**
 * Commands implement mode auto-allows. Contract data. Kept module-private —
 * the per-mode accessor that once exposed it has no caller and is not built.
 */
const ACCEPT_EDITS_COMMANDS: ReadonlySet<string> = new Set([
  'mkdir',
  'touch',
  'rm',
  'rmdir',
  'mv',
  'cp',
  'sed',
])

/**
 * Decide whether the current permission mode auto-allows this command. Returns
 * a non-passthrough result only when implement mode covers a subcommand;
 * bypass-posture and never-ask modes are handled by the main flow and short
 * out here with passthrough.
 */
export function checkPermissionMode<I extends { command: string }>(
  input: I,
  toolPermissionContext: ToolPermissionContext,
): PermissionResult<I> {
  // Bypass-posture (sovereign / autopilot) and never-ask (dontAsk) are
  // decided elsewhere; do not inspect the command here.
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
        // The allow carries the matched subcommand alone, never the whole input.
        updatedInput: { command: subcommand } as unknown as I,
        decisionReason: { type: 'mode', mode: 'implement' },
      }
    }
  }

  return { behavior: 'passthrough', message: 'No mode handling was required.' }
}
