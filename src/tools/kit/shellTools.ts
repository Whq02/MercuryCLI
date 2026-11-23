import { flagEnv } from '../../platform/substrate/flagRegistry.js'
import { BASH_TOOL_NAME } from './names/bash.js'
import { POWERSHELL_TOOL_NAME } from './names/powershell.js'
import { isEnvTruthy } from '../../platform/environment/envUtils.js'
import { windowsBashRoad, windowsShellRoadActive } from '../../platform/shell/windowsShellRoad.js'

export const SHELL_TOOL_NAMES: string[] = [BASH_TOOL_NAME, POWERSHELL_TOOL_NAME]

export function isPowerShellToolEnabled(): boolean {
  if (!windowsShellRoadActive()) return false
  return isEnvTruthy(flagEnv('MERCURY_USE_POWERSHELL_TOOL')) || windowsBashRoad().kind === 'absent'
}

export function firstCommandWord(subcommand: string): string {
  return subcommand.trim().split(/\s+/)[0]
}
