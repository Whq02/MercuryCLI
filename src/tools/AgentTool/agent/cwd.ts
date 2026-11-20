import { realpathSync, statSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import { hasControlCharacter } from '../../../utils/path.js'
import type { PermissionAskDecision } from '../../../types/permissions.js'
import { pathInAllowedWorkingPath } from '../../../utils/permissions/filesystem.js'
import { modeBypassesPermissions } from '../../../utils/permissions/PermissionMode.js'
import type { ToolPermissionContext } from '../../../Tool.js'
import { getCwd } from '../../../utils/cwd.js'
import { getPlatform } from '../../../utils/platform.js'
import { posixPathToWindowsPath } from '../../../utils/windowsPaths.js'
import { passedOver } from '../../../utils/passedOver.js'

function agentDirectoryOf(spelling: string): string {
  if (!isAbsolute(spelling) || hasControlCharacter(spelling)) {
    throw new Error(`cwd must be an absolute directory: ${spelling} (the session folder is ${getCwd()})`)
  }
  const onDisk = getPlatform() === 'windows' && /^\/[a-zA-Z]\//.test(spelling) ? posixPathToWindowsPath(spelling) : spelling
  const entry = (() => {
    try {
      return statSync(onDisk)
    } catch (error) {
      passedOver(error)
      return null
    }
  })()
  if (entry === null) {
    throw new Error(`cwd does not exist: ${spelling} (the session folder is ${getCwd()})`)
  }
  if (!entry.isDirectory()) throw new Error(`cwd is not a folder: ${spelling}`)
  return realpathSync(onDisk)
}

export function resolveAgentCwd(spelling: string, _permissionContext: ToolPermissionContext, _options?: { admit?: boolean }): string {
  return agentDirectoryOf(spelling)
}

export function agentCwdQuestion(spelling: string, permissionContext: ToolPermissionContext): PermissionAskDecision | null {
  let dir: string
  try {
    dir = agentDirectoryOf(spelling)
  } catch (error) {
    passedOver(error)
    return null
  }
  if (pathInAllowedWorkingPath(dir, permissionContext) || modeBypassesPermissions(permissionContext.mode)) return null
  return {
    behavior: 'ask',
    message: `Allow the crewmate to start in ${dir}, outside this session's starting folder?`,
    decisionReason: { type: 'workingDir', reason: `The crewmate would start in ${dir}` },
  }
}
