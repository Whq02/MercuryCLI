import { statSync } from 'fs'
import { homedir } from 'os'
import { resolve } from 'path'
import { getIsNonInteractiveSession, getSessionTrustAccepted, setSessionTrustAccepted } from '../../boot/process-state/processState.js'
import { getCwd } from '../files/cwd.js'
import { logForDebugging } from '../logs/debugLog.js'
import { normalizePathForConfigKey } from '../files/path.js'
import { passedOver } from '../errors/passedOver.js'

import type { GlobalConfig } from './schema.js'
import { getGlobalConfig, isConfigReadingAllowed, saveGlobalConfig } from './globalConfig.js'
import { getProjectPathForConfig, saveCurrentProjectConfigDeferred, unseenProjectConfig } from './projectConfig.js'

let _trustAccepted = false

export function resetTrustDialogAcceptedCacheForTesting(): void {
  _trustAccepted = false
}

export function isHomeDirectory(dir: string): boolean {
  if (normalizePathForConfigKey(resolve(dir)) === normalizePathForConfigKey(homedir())) return true
  try {
    const folder = statSync(dir)
    const home = statSync(homedir())
    return folder.dev === home.dev && folder.ino === home.ino
  } catch (error) {
    passedOver(error)
    return false
  }
}

function trustDialogAnswer(): boolean {
  if (getSessionTrustAccepted()) return true
  const config = getGlobalConfig()
  const cwd = getCwd()
  if (isHomeDirectory(cwd) && config.hasHomeTrustDialogAccepted) return true
  const projects = config.projects
  return grantedUnder(projects, [getProjectPathForConfig()]) || grantedUnder(projects, ancestorKeys(cwd))
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
  const config = getGlobalConfig()
  const resolved = resolve(dir)
  if (isHomeDirectory(resolved) && config.hasHomeTrustDialogAccepted) return true
  return grantedUnder(config.projects, ancestorKeys(resolved))
}

export function setPathTrusted(dir: string): void {
  const key = normalizePathForConfigKey(resolve(dir))
  if (isHomeDirectory(dir)) {
    setSessionTrustAccepted(true)
    saveGlobalConfig(current =>
      current.hasHomeTrustDialogAccepted ? current : { ...current, hasHomeTrustDialogAccepted: true },
    )
    return
  }
  saveGlobalConfig(current => {
    const record = current.projects?.[key]
    if (record?.hasTrustDialogAccepted) return current
    return {
      ...current,
      projects: { ...current.projects, [key]: { ...(record ?? unseenProjectConfig(current)), hasTrustDialogAccepted: true } },
    }
  })
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
