//  global config (hasTrustDialogAccepted, keyed by normalized path), plus one
import { homedir } from 'os'
import { resolve } from 'path'
import { getIsNonInteractiveSession, getSessionTrustAccepted, setSessionTrustAccepted } from '../../bootstrap/state.js'
import { getCwd } from '../../utils/cwd.js'
import { logForDebugging } from '../debug.js'
import { normalizePathForConfigKey } from '../path.js'

import { DEFAULT_PROJECT_CONFIG } from './schema.js'
import { getGlobalConfig, saveGlobalConfig } from './globalConfig.js'
import { getProjectPathForConfig, saveCurrentProjectConfigDeferred } from './projectConfig.js'

let _trustAccepted = false

export function resetTrustDialogAcceptedCacheForTesting(): void {
  _trustAccepted = false
}

export function checkHasTrustDialogAccepted(): boolean {
  return (_trustAccepted ||= computeTrustDialogAccepted())
}

export function untrustedWorkspaceHeadless(): boolean {
  try {
    if (!getIsNonInteractiveSession()) return false
    return !checkHasTrustDialogAccepted()
  } catch {
    return false
  }
}

function computeTrustDialogAccepted(): boolean {
  if (getSessionTrustAccepted()) {
    return true
  }

  const config = getGlobalConfig()

  const projectPath = getProjectPathForConfig()
  const projectConfig = config.projects?.[projectPath]
  if (projectConfig?.hasTrustDialogAccepted) {
    return true
  }

  let currentPath = normalizePathForConfigKey(getCwd())

  while (true) {
    const pathConfig = config.projects?.[currentPath]
    if (pathConfig?.hasTrustDialogAccepted) {
      return true
    }

    const parentPath = normalizePathForConfigKey(resolve(currentPath, '..'))
    if (parentPath === currentPath) {
      break
    }
    currentPath = parentPath
  }

  return false
}

export function isPathTrusted(dir: string): boolean {
  const config = getGlobalConfig()
  let currentPath = normalizePathForConfigKey(resolve(dir))
  while (true) {
    if (config.projects?.[currentPath]?.hasTrustDialogAccepted) return true
    const parentPath = normalizePathForConfigKey(resolve(currentPath, '..'))
    if (parentPath === currentPath) return false
    currentPath = parentPath
  }
}

export function setPathTrusted(dir: string): void {
  const absolutePath = normalizePathForConfigKey(resolve(dir))
  if (absolutePath === normalizePathForConfigKey(homedir())) {
    setSessionTrustAccepted(true)
    return
  }
  saveGlobalConfig(current => {
    if (current.projects?.[absolutePath]?.hasTrustDialogAccepted) {
      return current
    }
    return {
      ...current,
      projects: {
        ...current.projects,
        [absolutePath]: {
          ...(current.projects?.[absolutePath] ?? DEFAULT_PROJECT_CONFIG),
          hasTrustDialogAccepted: true,
        },
      },
    }
  })
}

export function isProjectScopeTrustAccepted(): boolean {
  return checkHasTrustDialogAccepted()
}


export type PermissionPostureRecord = NonNullable<
  import('./schema.js').ProjectConfig['permissionPosture']
>

export function recordPermissionPosture(input: {
  bypassArmed: boolean
  envArmed: boolean
  flagArmed: boolean
  dialogSuppressed: boolean
}): void {
  try {
    const record: PermissionPostureRecord = input.bypassArmed
      ? {
          mode: 'bypass',
          armedBy: input.envArmed
            ? 'env-standing-consent'
            : input.flagArmed
              ? 'cli-flag'
              : 'session-choice',
          consentDialog: input.dialogSuppressed
            ? 'suppressed-by-standing-consent'
            : 'shown-accepted',
          trustDialogAccepted: checkHasTrustDialogAccepted(),
          recordedAtMs: Date.now(),
        }
      : {
          mode: 'standard',
          consentDialog: 'not-required',
          trustDialogAccepted: checkHasTrustDialogAccepted(),
          recordedAtMs: Date.now(),
        }
    saveCurrentProjectConfigDeferred(current => {
      const prev = current.permissionPosture
      if (
        prev &&
        prev.mode === record.mode &&
        prev.armedBy === record.armedBy &&
        prev.consentDialog === record.consentDialog &&
        prev.trustDialogAccepted === record.trustDialogAccepted
      ) {
        return current
      }
      return { ...current, permissionPosture: record }
    })
  } catch (e) {
    logForDebugging(`[trust] permission-posture record failed (boot continues): ${e}`)
  }
}
