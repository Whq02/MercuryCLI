// ============================================================================
//  src/utils/config/projectConfig.ts — the per-project slice of the global
//  config, keyed by normalized project path (git root when there is one,
//  else the boot cwd). Reads come off the cached global view; saves ride the
//  same locked global save path — a project save IS a global save that
//  replaces one project record.
//
//  TWO DOORS, ONE SLICE: the cwd-keyed pair (getCurrentProjectConfig /
//  saveCurrentProjectConfig) answers THIS process's project through a
//  process-lifetime memo — right for a runner, whose key must not move when
//  the session cd's around — and the workspace-keyed pair
//  (getProjectConfigForWorkspace / saveProjectConfigForWorkspace) answers an
//  EXPLICIT repo's slice: the daemon deriving a session's kit for a birth in
//  another repo, the boot face writing the menu after the projects picker's
//  ground move (nothing resets the memo there — the cwd door would write the
//  boot cwd's slice). Both pairs share one read and one write below.
//
//  config.ts is the compatibility barrel over this family; submodules never
//  import the barrel.
// ============================================================================
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
  saveConfig,
  saveConfigWithLock,
  wouldLoseAuthState,
  writeThroughGlobalConfigCache,
  noteConfigContentionRefusal,
  noteConfigLocklessFallback,
} from './globalConfig.js'

// Under bun test the project config is a plain in-memory object, mirroring
// globalConfig's test short-circuit (reads return it, saves assign into it).
// One slice answers for every workspace there.
const TEST_PROJECT_CONFIG_FOR_TESTING: ProjectConfig = {
  ...DEFAULT_PROJECT_CONFIG,
}

/** The ONE key derivation: the canonical git root when the folder is inside
 *  a repo, else the folder itself — normalized (forward slashes, stable
 *  drive-letter case) so the same project maps to the same JSON key on
 *  every platform. */
function projectConfigKeyOf(dir: string): string {
  const gitRoot = findCanonicalGitRoot(dir)

  if (gitRoot) {
    return normalizePathForConfigKey(gitRoot)
  }

  return normalizePathForConfigKey(resolve(dir))
}

/**
 * The config key for an EXPLICIT workspace. The argument is REALPATH'd first
 * (when the folder exists): a runner's own key derives from its process cwd,
 * which is always the real path (the daemon spawns it on the canonical,
 * realpath'd workspace id) — so an explicit door handed a symlinked spelling
 * of the same folder (macOS's /var → /private/var, a linked checkout) must
 * land on THAT key, never open a second row for one repo. The cwd door below
 * keeps its exact historical derivation.
 */
export function projectConfigKeyForWorkspace(workspaceDir: string): string {
  let dir = workspaceDir
  try {
    dir = realpathSync(workspaceDir)
  } catch {
    // A folder that does not exist (yet) keys by its given spelling.
  }
  return projectConfigKeyOf(dir)
}

/**
 * The config key for THIS session's project — the boot cwd's, through the
 * one derivation. Memoized for the process lifetime: the key must not move
 * when the session cd's around.
 */
export const getProjectPathForConfig = memoize((): string => projectConfigKeyOf(getOriginalCwd()))

/** The slice under one key, off the cached global view — the one read. */
function readProjectSlice(absolutePath: string): ProjectConfig {
  const config = getGlobalConfig()

  if (!config.projects) {
    return DEFAULT_PROJECT_CONFIG
  }

  const projectConfig = config.projects[absolutePath] ?? DEFAULT_PROJECT_CONFIG
  // Repair a legacy corruption seen in the field: allowedTools persisted as
  // a JSON STRING rather than an array. Coerce in place so downstream
  // consumers always see an array. Guarded against the module-level
  // singleton: on a project miss `projectConfig` IS the shared
  // DEFAULT_PROJECT_CONFIG, and mutating its `allowedTools` would corrupt it
  // process-wide. (Its default is always [], so the branch never fires for
  // the singleton today — the guard makes that latent footgun impossible.)
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

/** The slice of an EXPLICIT workspace's repo (the workspace-keyed read):
 *  the same view, the same repair, that repo's key. */
export function getProjectConfigForWorkspace(workspaceDir: string): ProjectConfig {
  if (process.env.NODE_ENV === 'test') {
    return TEST_PROJECT_CONFIG_FOR_TESTING
  }

  return readProjectSlice(projectConfigKeyForWorkspace(workspaceDir))
}

function saveTestProjectSlice(updater: (currentConfig: ProjectConfig) => ProjectConfig): void {
  const config = updater(TEST_PROJECT_CONFIG_FOR_TESTING)
  // Same-reference return = "no change"; skip the assign.
  if (config === TEST_PROJECT_CONFIG_FOR_TESTING) {
    return
  }
  Object.assign(TEST_PROJECT_CONFIG_FOR_TESTING, config)
}

/** The slice under one key, written through the locked global save — the
 *  one write (the lockless fallback beneath it is the same degraded-read
 *  race as saveGlobalConfig's, defended by the same auth-wipe guard). */
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
        // Same-reference return = "no change"; skip the write.
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
    // Present-but-unreadable file: no view to merge onto — refuse the write
    // (the same refusal as saveGlobalConfig's; the lockless re-read below
    // would fail the same way).
    if (error instanceof ConfigReadError) {
      logForDebugging(
        `saveCurrentProjectConfig: refusing the write — ${error.message}`,
        { level: 'error' },
      )
      return
    }
    // Lock-ladder exhaustion: refuse rather than rewrite the monolith from
    // an unlocked read over the holder's just-committed state
    // (release-hardening audit rank 42 — the same refusal as
    // saveGlobalConfig's).
    if ((error as NodeJS.ErrnoException | null)?.code === 'ELOCKED') {
      noteConfigContentionRefusal('writeProjectSlice')
      return
    }
    logForDebugging(`Failed to save config with lock: ${error}`, {
      level: 'error',
    })
    noteConfigLocklessFallback()

    // Lockless fallback — the same degraded-read race as saveGlobalConfig's
    // fallback, defended by the same auth-wipe guard (globalConfig.ts).
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
    const currentProjectConfig =
      config.projects?.[absolutePath] ?? DEFAULT_PROJECT_CONFIG
    const newProjectConfig = updater(currentProjectConfig)
    // Same-reference return = "no change"; skip the write.
    if (newProjectConfig === currentProjectConfig) {
      return
    }
    written = {
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

/** The workspace-keyed write: an EXPLICIT repo's slice through the same
 *  locked save. The boot face's menu pens ride this after a ground move;
 *  the cwd door would have written the boot cwd's slice. */
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
