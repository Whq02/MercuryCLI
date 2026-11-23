import memoize from 'lodash-es/memoize.js'
import { realpathSync } from 'fs'
import { resolve } from 'path'
import { getOriginalCwd } from '../../bootstrap/state.js'
import { getGlobalMercuryFile } from '../env.js'
import { findCanonicalGitRoot } from '../git.js'
import { safeParseJSON } from '../json.js'
import { logForDebugging } from '../debug.js'
import { ConfigReadError } from '../errors.js'
import { getErrnoCode } from '../errors.js'
import { normalizePathForConfigKey } from '../path.js'

import {
  createDefaultGlobalConfig,
  DEFAULT_GLOBAL_CONFIG,
  DEFAULT_PROJECT_CONFIG,
  type GlobalConfig,
  type ProjectConfig,
} from './schema.js'
import {
  getConfig,
  getGlobalConfig,
  foldPendingUpdaters,
  hasPendingDeferredGlobalConfigSaves,
  saveConfig,
  saveGlobalConfigDeferred,
  saveConfigWithLock,
  wouldLoseAuthState,
  writeThroughGlobalConfigCache,
  noteConfigContentionRefusal,
  noteConfigLocklessFallback,
} from './globalConfig.js'

type SliceUpdater = (currentConfig: ProjectConfig) => ProjectConfig

const underTest = (): boolean => process.env.NODE_ENV === 'test'

const TEST_PROJECT_CONFIG_FOR_TESTING: ProjectConfig = { ...DEFAULT_PROJECT_CONFIG }

function projectConfigKeyOf(dir: string): string {
  return normalizePathForConfigKey(findCanonicalGitRoot(dir) ?? resolve(dir))
}

const realFolderOr = (spelling: string): string => {
  try {
    return realpathSync(spelling)
  } catch {
    return spelling
  }
}

export function projectConfigKeyForWorkspace(workspaceDir: string): string {
  return projectConfigKeyOf(realFolderOr(workspaceDir))
}

export const getProjectPathForConfig = memoize((): string => projectConfigKeyOf(getOriginalCwd()))

const recordOf = (config: GlobalConfig, key: string): ProjectConfig => config.projects?.[key] ?? DEFAULT_PROJECT_CONFIG

function withRecordReplaced(config: GlobalConfig, key: string, updater: SliceUpdater): GlobalConfig | null {
  const current = recordOf(config, key)
  const next = updater(current)
  return next === current ? null : { ...config, projects: { ...config.projects, [key]: next } }
}

function readProjectRecord(key: string): ProjectConfig {
  const record = recordOf(getGlobalConfig(), key)
  if (record !== DEFAULT_PROJECT_CONFIG && typeof record.allowedTools === 'string') {
    record.allowedTools = (safeParseJSON(record.allowedTools) ?? []) as string[]
  }
  return record
}

export function getCurrentProjectConfig(): ProjectConfig {
  return underTest() ? TEST_PROJECT_CONFIG_FOR_TESTING : readProjectRecord(getProjectPathForConfig())
}

export function getProjectConfigForWorkspace(workspaceDir: string): ProjectConfig {
  return underTest() ? TEST_PROJECT_CONFIG_FOR_TESTING : readProjectRecord(projectConfigKeyForWorkspace(workspaceDir))
}

function saveTestProjectSlice(updater: SliceUpdater): void {
  const next = updater(TEST_PROJECT_CONFIG_FOR_TESTING)
  if (next !== TEST_PROJECT_CONFIG_FOR_TESTING) Object.assign(TEST_PROJECT_CONFIG_FOR_TESTING, next)
}

const refuse = (why: string): void => logForDebugging(why, { level: 'error' })

function writeProjectSliceUnderLock(file: string, key: string, updater: SliceUpdater): void {
  const made: { replaced: GlobalConfig | null } = { replaced: null }
  const written = saveConfigWithLock(file, createDefaultGlobalConfig, current => {
    made.replaced = withRecordReplaced(current, key, updater)
    return made.replaced ?? current
  })
  if (written && made.replaced !== null) writeThroughGlobalConfigCache(made.replaced)
}

function rereadForLocklessWrite(file: string): GlobalConfig | null {
  let fresh: GlobalConfig
  try {
    fresh = getConfig(file, createDefaultGlobalConfig)
  } catch (error) {
    if (!(error instanceof ConfigReadError)) throw error
    refuse(`saveCurrentProjectConfig fallback: refusing the write — ${error.message}`)
    return null
  }
  if (wouldLoseAuthState(fresh)) {
    refuse('saveCurrentProjectConfig fallback: the re-read view lost auth state the cache still holds; refusing the write (auth-wipe guard).')
    return null
  }
  return fresh
}

function writeProjectSliceWithoutLock(file: string, key: string, updater: SliceUpdater): void {
  const fresh = rereadForLocklessWrite(file)
  if (fresh === null) return
  const folded = foldPendingUpdaters(fresh)
  const replaced = withRecordReplaced(folded, key, updater)
  if (replaced === null && !hasPendingDeferredGlobalConfigSaves()) return
  const next = replaced ?? folded
  saveConfig(file, next, DEFAULT_GLOBAL_CONFIG)
  writeThroughGlobalConfigCache(next)
}

function writeProjectSlice(absolutePath: string, updater: SliceUpdater): void {
  const file = getGlobalMercuryFile()
  try {
    writeProjectSliceUnderLock(file, absolutePath, updater)
  } catch (error) {
    if (error instanceof ConfigReadError) {
      refuse(`saveCurrentProjectConfig: refusing the write — ${error.message}`)
      return
    }
    if (getErrnoCode(error) === 'ELOCKED') {
      noteConfigContentionRefusal('writeProjectSlice')
      return
    }
    refuse(`Failed to save config with lock: ${error}`)
    noteConfigLocklessFallback()
    writeProjectSliceWithoutLock(file, absolutePath, updater)
  }
}

export function saveCurrentProjectConfigDeferred(updater: SliceUpdater): void {
  if (underTest()) {
    saveTestProjectSlice(updater)
    return
  }
  const key = getProjectPathForConfig()
  saveGlobalConfigDeferred(config => withRecordReplaced(config, key, updater) ?? config)
}

export function saveCurrentProjectConfig(updater: SliceUpdater): void {
  if (underTest()) {
    saveTestProjectSlice(updater)
    return
  }
  writeProjectSlice(getProjectPathForConfig(), updater)
}

export function saveProjectConfigForWorkspace(workspaceDir: string, updater: SliceUpdater): void {
  if (underTest()) {
    saveTestProjectSlice(updater)
    return
  }
  writeProjectSlice(projectConfigKeyForWorkspace(workspaceDir), updater)
}
