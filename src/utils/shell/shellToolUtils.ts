import { BASH_TOOL_NAME } from '../../tools/BashTool/toolName.js'
import { POWERSHELL_TOOL_NAME } from '../../tools/PowerShellTool/toolName.js'
import { isEnvTruthy } from '../envUtils.js'
import { windowsBashRoad, windowsShellRoadActive } from './windowsShellRoad.js'

export const SHELL_TOOL_NAMES: string[] = [BASH_TOOL_NAME, POWERSHELL_TOOL_NAME]

export function isPowerShellToolEnabled(): boolean {
  if (!windowsShellRoadActive()) return false
  if (isEnvTruthy(process.env.MERCURY_USE_POWERSHELL_TOOL)) return true
  return windowsBashRoad().kind === 'absent'
}

export function firstCommandWord(subcommand: string): string {
  return subcommand.trim().split(/\s+/)[0] ?? ''
}
