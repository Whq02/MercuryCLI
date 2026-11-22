import { flagEnv } from '../../substrate/flagRegistry.js'
import { BASH_TOOL_NAME } from '../../constants/tools/bash.js'
import { POWERSHELL_TOOL_NAME } from '../../constants/tools/powershell.js'
import { isEnvTruthy } from '../envUtils.js'
import { windowsBashRoad, windowsShellRoadActive } from './windowsShellRoad.js'
import { notBuilt, unbuilt } from '../../pi/holes.js'

export const SHELL_TOOL_NAMES: string[] = unbuilt('src/utils/shell/shellToolUtils.ts:7')

export function isPowerShellToolEnabled(): boolean {
  return notBuilt('src/utils/shell/shellToolUtils.ts:9')
}

export function firstCommandWord(subcommand: string): string {
  return notBuilt('src/utils/shell/shellToolUtils.ts:15')
}
