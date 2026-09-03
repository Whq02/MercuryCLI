/**
 * The shell tool-name list and the single runtime predicate gating PowerShell
 * tool availability. The registered MERCURY spelling is decoded here, one
 * rung below the flag registry.
 */
import { BASH_TOOL_NAME } from '../../tools/BashTool/toolName.js'
import { POWERSHELL_TOOL_NAME } from '../../tools/PowerShellTool/toolName.js'
import { isEnvTruthy } from '../envUtils.js'
import { getPlatform } from '../platform.js'

/** The Bash and PowerShell tool names, in that order. */
export const SHELL_TOOL_NAMES: string[] = [BASH_TOOL_NAME, POWERSHELL_TOOL_NAME]

/**
 * Whether the PowerShell tool exists. The ONLY such predicate (three call
 * sites must agree). Non-Windows: always disabled. On Windows: enabled iff
 * the env value is truthy. Read at call time so a mid-session env change
 * takes effect.
 */
export function isPowerShellToolEnabled(): boolean {
  if (getPlatform() !== 'windows') return false
  return isEnvTruthy(process.env.MERCURY_USE_POWERSHELL_TOOL)
}

/**
 * The command word of a subcommand: its first whitespace-delimited token,
 * the name a never-auto-background list is compared with (`sleep 30` is
 * `sleep`). The ONE owner for both shell tools; the whole subcommand was
 * compared once, so a sleep with an argument never matched.
 */
export function firstCommandWord(subcommand: string): string {
  return subcommand.trim().split(/\s+/)[0] ?? ''
}
