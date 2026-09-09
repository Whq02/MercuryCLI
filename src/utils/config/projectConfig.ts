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
  saveConfigWithLock,
  wouldLoseAuthState,
  writeThroughGlobalConfigCache,
  noteConfigContentionRefusal,
  noteConfigLocklessFallback,
} from './globalConfig.js'

const TEST_PROJECT_CONFIG_FOR_TESTING: ProjectConfig = {
  ...DEFAULT_PROJECT_CONFIG,
}

function projectConfigKeyOf(dir: string): string {
  const gitRoot = findCanonicalGitRoot(dir)

  if (gitRoot) {
    return normalizePathForConfigKey(gitRoot)
  }

  return normalizePathForConfigKey(resolve(dir))
}

export function projectConfigKeyForWorkspace(workspaceDir: string): string {
  let dir = workspaceDir
  try {
    dir = realpathSync(workspaceDir)
  } catch {
  }
  return projectConfigKeyOf(dir)
}

export const getProjectPathForConfig = memoize((): string => projectConfigKeyOf(getOriginalCwd()))

function readProjectSlice(absolutePath: string): ProjectConfig {
  const config = getGlobalConfig()

  if (!config.projects) {
    return DEFAULT_PROJECT_CONFIG
  }

  const projectConfig = config.projects[absolutePath] ?? DEFAULT_PROJECT_CONFIG
  if (
    projectConfig !== DEFAULT_PROJECT_CONFIG &&
    typeof projectConfig.allowedTools === 'string'
  ) {
    projectConfig.allowedTools =
      (safeParseJSON(projectConfig.allowedTools) as string[]) ?? []
  }

  return projectConfig
}

export function getCurrentProjectConfig(): ProjectConfig {
  if (process.env.NODE_ENV === 'test') {
    return TEST_PROJECT_CONFIG_FOR_TESTING
  }

  return readProjectSlice(getProjectPathForConfig())
}

export function getProjectConfigForWorkspace(workspaceDir: string): ProjectConfig {
  if (process.env.NODE_ENV === 'test') {
    return TEST_PROJECT_CONFIG_FOR_TESTING
  }

  return readProjectSlice(projectConfigKeyForWorkspace(workspaceDir))
}

function saveTestProjectSlice(updater: (currentConfig: ProjectConfig) => ProjectConfig): void {
  const config = updater(TEST_PROJECT_CONFIG_FOR_TESTING)
  if (config === TEST_PROJECT_CONFIG_FOR_TESTING) {
    return
  }
  Object.assign(TEST_PROJECT_CONFIG_FOR_TESTING, config)
}

function writeProjectSlice(
  absolutePath: string,
  updater: (currentConfig: ProjectConfig) => ProjectConfig,
): void {
  let written: GlobalConfig | null = null
  try {
    const didWrite = saveConfigWithLock(
      getGlobalMercuryFile(),
      createDefaultGlobalConfig,
      current => {
        const currentProjectConfig =
          current.projects?.[absolutePath] ?? DEFAULT_PROJECT_CONFIG
        const newProjectConfig = updater(currentProjectConfig)
        if (newProjectConfig === currentProjectConfig) {
          return current
        }
        written = {
          ...current,
          projects: {
            ...current.projects,
            [absolutePath]: newProjectConfig,
          },
        }
        return written
      },
    )
    if (didWrite && written) {
      writeThroughGlobalConfigCache(written)
    }
  } catch (error) {
    if (error instanceof ConfigReadError) {
      logForDebugging(
        `saveCurrentProjectConfig: refusing the write — ${error.message}`,
        { level: 'error' },
      )
      return
    }
    if ((error as NodeJS.ErrnoException | null)?.code === 'ELOCKED') {
      noteConfigContentionRefusal('writeProjectSlice')
      return
    }
    logForDebugging(`Failed to save config with lock: ${error}`, {
      level: 'error',
    })
    noteConfigLocklessFallback()

    let config: GlobalConfig
    try {
      config = getConfig(getGlobalMercuryFile(), createDefaultGlobalConfig)
    } catch (readError) {
      if (readError instanceof ConfigReadError) {
        logForDebugging(
          `saveCurrentProjectConfig fallback: refusing the write — ${readError.message}`,
          { level: 'error' },
        )
        return
      }
      throw readError
    }
    if (wouldLoseAuthState(config)) {
      logForDebugging(
        'saveCurrentProjectConfig fallback: the re-read view lost auth state the cache still holds; refusing the write (auth-wipe guard).',
        { level: 'error' },
      )
      return
    }
    config = foldPendingUpdaters(config)
    const currentProjectConfig =
      config.projects?.[absolutePath] ?? DEFAULT_PROJECT_CONFIG
    const newProjectConfig = updater(currentProjectConfig)
    if (newProjectConfig === currentProjectConfig && !hasPendingDeferredGlobalConfigSaves()) {
      return
    }
    written = newProjectConfig === currentProjectConfig ? config : {
      ...config,
      projects: {
        ...config.projects,
        [absolutePath]: newProjectConfig,
      },
    }
    saveConfig(getGlobalMercuryFile(), written, DEFAULT_GLOBAL_CONFIG)
    writeThroughGlobalConfigCache(written)
  }
}

export function saveCurrentProjectConfig(
  updater: (currentConfig: ProjectConfig) => ProjectConfig,
): void {
  if (process.env.NODE_ENV === 'test') {
    saveTestProjectSlice(updater)
    return
  }
  writeProjectSlice(getProjectPathForConfig(), updater)
}

export function saveProjectConfigForWorkspace(
  workspaceDir: string,
  updater: (currentConfig: ProjectConfig) => ProjectConfig,
): void {
  if (process.env.NODE_ENV === 'test') {
    saveTestProjectSlice(updater)
    return
  }
  writeProjectSlice(projectConfigKeyForWorkspace(workspaceDir), updater)
}
