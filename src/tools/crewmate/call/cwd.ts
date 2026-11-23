import { realpathSync, statSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import { hasControlCharacter } from '../../../platform/files/path.js'
import type { PermissionAskDecision } from '../../../permissions/rules/permissions.js'
import { pathInAllowedWorkingPath } from '../../../permissions/rules/filesystem.js'
import { modeBypassesPermissions } from '../../../permissions/rules/permissionMode.js'
import type { ToolPermissionContext } from '../../kit/tool.js'
import { getCwd } from '../../../platform/files/cwd.js'
import { rememberedPlatform } from '../../../platform/host-os/host.js'
import { msysDrivePathToNative } from '../../../platform/host-os/paths.js'
import { getErrnoCode } from '../../../platform/errors/errors.js'
import { passedOver } from '../../../platform/errors/passedOver.js'

function agentDirectoryOf(spelling: string): string {
  if (!isAbsolute(spelling) || hasControlCharacter(spelling)) {
    throw new Error(`cwd must be an absolute directory: ${spelling} (the session folder is ${getCwd()})`)
  }
  const onDisk = msysDrivePathToNative(spelling, false, rememberedPlatform())
  const entry = (() => {
    try {
      return statSync(onDisk)
    } catch (error) {
      if (getErrnoCode(error) === 'ENOENT') return null
      throw error
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
