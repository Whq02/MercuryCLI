import { modeBypassesPermissions } from '../../utils/permissions/PermissionMode.js'
import type { PermissionResult } from '../../utils/permissions/PermissionResult.js'
import type { ToolPermissionContext } from '../../Tool.js'
import { preparedSecurityParse } from '../../utils/permissions/decision/commandAnalysis.js'
import { ownGroundCommand } from '../../utils/permissions/ownGround.js'
import { resolveShellCwd } from '../../utils/Shell.js'
import { notBuilt } from '../../pi/holes.js'

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
  return notBuilt('src/tools/BashTool/modeValidation.ts:18')
}
