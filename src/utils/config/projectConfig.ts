import memoize from 'lodash-es/memoize.js'
import { realpathSync } from 'fs'
import { resolve } from 'path'
import { getOriginalCwd } from '../../bootstrap/state.js'
import { getGlobalMercuryFile } from '../env.js'
import { findCanonicalGitRoot } from '../git.js'
import { safeParseJSON } from '../json.js'
import { logForDebugging } from '../debug.js'
import { ConfigReadError } from '../errors.js'
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
import { notBuilt } from '../../pi/holes.js'

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

export function getCurrentProjectConfig(): ProjectConfig {
  return notBuilt('src/utils/config/projectConfig.ts:73')
}

export function getProjectConfigForWorkspace(workspaceDir: string): ProjectConfig {
  return notBuilt('src/utils/config/projectConfig.ts:77')
}

function saveTestProjectSlice(updater: SliceUpdater): void {
  const next = updater(TEST_PROJECT_CONFIG_FOR_TESTING)
  if (next !== TEST_PROJECT_CONFIG_FOR_TESTING) Object.assign(TEST_PROJECT_CONFIG_FOR_TESTING, next)
}

const refuse = (why: string): void => logForDebugging(why, { level: 'error' })

function writeProjectSlice(absolutePath: string, updater: SliceUpdater): void {
  return notBuilt('src/utils/config/projectConfig.ts:122')
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
  return notBuilt('src/utils/config/projectConfig.ts:150')
}

export function saveProjectConfigForWorkspace(workspaceDir: string, updater: SliceUpdater): void {
  if (underTest()) {
    saveTestProjectSlice(updater)
    return
  }
  writeProjectSlice(projectConfigKeyForWorkspace(workspaceDir), updater)
}
