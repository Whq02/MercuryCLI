import { homedir } from 'os'
import { resolve } from 'path'
import { getIsNonInteractiveSession, getSessionTrustAccepted, setSessionTrustAccepted } from '../../boot/process-state/processState.js'
import { getCwd } from '../files/cwd.js'
import { logForDebugging } from '../logs/debugLog.js'
import { normalizePathForConfigKey } from '../files/path.js'

import { DEFAULT_PROJECT_CONFIG, type GlobalConfig } from './schema.js'
import { getGlobalConfig, isConfigReadingAllowed, saveGlobalConfig } from './globalConfig.js'
import { getProjectPathForConfig, saveCurrentProjectConfigDeferred } from './projectConfig.js'

let _trustAccepted = false

export function resetTrustDialogAcceptedCacheForTesting(): void {
  _trustAccepted = false
}

function trustDialogAnswer(): boolean {
  if (getSessionTrustAccepted()) return true
  const projects = getGlobalConfig().projects
  return grantedUnder(projects, [getProjectPathForConfig()]) || grantedUnder(projects, ancestorKeys(getCwd()))
}

export function checkHasTrustDialogAccepted(): boolean {
  return (_trustAccepted ||= trustDialogAnswer())
}

export function untrustedWorkspaceHeadless(): boolean {
  try {
    return getIsNonInteractiveSession() && !checkHasTrustDialogAccepted()
  } catch (error) {
    if (isConfigReadingAllowed()) {
      logForDebugging(
        `trust: whether this workspace is trusted could not be read, so this headless run goes on as in a trusted one: ${error instanceof Error ? error.message : String(error)}`,
        { level: 'warn' },
      )
    }
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

export function isPathTrusted(dir: string): boolean {
  return grantedUnder(getGlobalConfig().projects, ancestorKeys(resolve(dir)))
}

export function setPathTrusted(dir: string): void {
  const key = normalizePathForConfigKey(resolve(dir))
  if (key === normalizePathForConfigKey(homedir())) {
    setSessionTrustAccepted(true)
    return
  }
  saveGlobalConfig(current => {
    const record = current.projects?.[key]
    if (record?.hasTrustDialogAccepted) return current
    return {
      ...current,
      projects: { ...current.projects, [key]: { ...(record ?? DEFAULT_PROJECT_CONFIG), hasTrustDialogAccepted: true } },
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
