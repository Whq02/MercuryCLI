import { homedir } from 'os'
import { resolve } from 'path'
import { getIsNonInteractiveSession, getSessionTrustAccepted, setSessionTrustAccepted } from '../../bootstrap/state.js'
import { getCwd } from '../../utils/cwd.js'
import { logForDebugging } from '../debug.js'
import { normalizePathForConfigKey } from '../path.js'

import { DEFAULT_PROJECT_CONFIG, type GlobalConfig } from './schema.js'
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

function* ancestorKeys(start: string): Generator<string> {
  let key = normalizePathForConfigKey(start)
  while (true) {
    yield key
    const parent = normalizePathForConfigKey(resolve(key, '..'))
    if (parent === key) return
    key = parent
  }
}

function grantedUnder(projects: GlobalConfig['projects'], keys: Iterable<string>): boolean {
  for (const key of keys) {
    if (projects?.[key]?.hasTrustDialogAccepted) return true
  }
  return false
}

function computeTrustDialogAccepted(): boolean {
  if (getSessionTrustAccepted()) return true
  const { projects } = getGlobalConfig()
  return (
    grantedUnder(projects, [getProjectPathForConfig()]) ||
    grantedUnder(projects, ancestorKeys(getCwd()))
  )
}

export function isPathTrusted(dir: string): boolean {
  return grantedUnder(getGlobalConfig().projects, ancestorKeys(resolve(dir)))
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
