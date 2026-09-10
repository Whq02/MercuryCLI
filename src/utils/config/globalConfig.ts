import { copyFileSync, mkdirSync, unwatchFile, watchFile } from 'fs'
import pickBy from 'lodash-es/pickBy.js'
import { basename, dirname, join } from 'path'
import { registerCleanup } from '../cleanupRegistry.js'
import { logForDebugging } from '../debug.js'
import { logForDiagnosticsNoPII } from '../diagLogs.js'
import { getGlobalMercuryFile } from '../env.js'
import { getMercuryHome } from '../envUtils.js'
import { ConfigParseError, ConfigReadError, getErrnoCode } from '../errors.js'
import { writeFileSyncAndFlush_DEPRECATED } from '../file.js'
import { getFsImplementation } from '../fsOperations.js'
import { safeParseJSON } from '../json.js'
import { stripBOM } from '../jsonRead.js'
import * as lockfile from '../lockfile.js'
import { logError } from '../log.js'
import { rewriteRetiredGlobalConfigKeys, rewriteRetiredProjectConfigKeys } from '../../migrations/migrateConfigSpellings.js'
import { jsonParse, jsonStringify } from '../slowOperations.js'

import {
  createDefaultGlobalConfig,
  DEFAULT_GLOBAL_CONFIG,
  type GlobalConfig,
  type ProjectConfig,
} from './schema.js'

const TEST_GLOBAL_CONFIG_FOR_TESTING: GlobalConfig = {
  ...DEFAULT_GLOBAL_CONFIG,
}

export function wouldLoseAuthState(fresh: {
  oauthAccount?: unknown
  hasCompletedOnboarding?: boolean
}): boolean {
  const cached = globalConfigCache.config
  if (!cached) return false
  const lostOauth =
    cached.oauthAccount !== undefined && fresh.oauthAccount === undefined
  const lostOnboarding =
    cached.hasCompletedOnboarding === true &&
    fresh.hasCompletedOnboarding !== true
  return lostOauth || lostOnboarding
}

let pendingDeferredUpdaters: Array<(currentConfig: GlobalConfig) => GlobalConfig> = []

let deferredExitFlushArmed = false
function armDeferredExitFlush(): void {
  if (deferredExitFlushArmed) return
  deferredExitFlushArmed = true
  process.once('exit', () => {
    try {
      if (hasPendingDeferredGlobalConfigSaves()) saveGlobalConfig(current => current)
    } catch {
    }
  })
}

export function foldPendingUpdaters(current: GlobalConfig): GlobalConfig {
  let folded = current
  for (const pending of pendingDeferredUpdaters) folded = pending(folded)
  return pendingDeferredUpdaters.length === 0 ? current : { ...folded, projects: removeProjectHistory(folded.projects) }
}

export function saveGlobalConfigDeferred(
  updater: (currentConfig: GlobalConfig) => GlobalConfig,
): void {
  if (process.env.NODE_ENV === 'test') {
    saveGlobalConfig(updater)
    return
  }
  const current = getGlobalConfig()
  const next = updater(current)
  if (next === current) return
  pendingDeferredUpdaters.push(updater)
  armDeferredExitFlush()
  writeThroughGlobalConfigCache({
    ...next,
    projects: removeProjectHistory(next.projects),
  })
}

export async function flushDeferredGlobalConfigSaves(): Promise<void> {
  for (let attempt = 0; attempt < 12; attempt++) {
    if (pendingDeferredUpdaters.length === 0) return
    try {
      saveConfigWithLock(getGlobalMercuryFile(), createDefaultGlobalConfig, current => current, false)
      return
    } catch (error) {
      if ((error as NodeJS.ErrnoException | null)?.code !== 'ELOCKED') {
        logError(error)
        return
      }
      await new Promise<void>(resolve => setTimeout(resolve, Math.min(1000, 15 * 2 ** attempt)))
    }
  }
  if (pendingDeferredUpdaters.length > 0) noteConfigContentionRefusal('flushDeferredGlobalConfigSaves')
}

export function hasPendingDeferredGlobalConfigSaves(): boolean {
  return pendingDeferredUpdaters.length > 0
}

export function saveGlobalConfig(
  updater: (currentConfig: GlobalConfig) => GlobalConfig,
): void {
  if (process.env.NODE_ENV === 'test') {
    const config = updater(TEST_GLOBAL_CONFIG_FOR_TESTING)
    if (config === TEST_GLOBAL_CONFIG_FOR_TESTING) {
      return
    }
    Object.assign(TEST_GLOBAL_CONFIG_FOR_TESTING, config)
    return
  }

  let written: GlobalConfig | null = null
  try {
    const didWrite = saveConfigWithLock(
      getGlobalMercuryFile(),
      createDefaultGlobalConfig,
      current => {
        const config = updater(current)
        if (config === current) {
          return current
        }
        written = {
          ...config,
          projects: removeProjectHistory(config.projects),
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
        `saveGlobalConfig: refusing the write — ${error.message}`,
        { level: 'error' },
      )
      return
    }
    if ((error as NodeJS.ErrnoException | null)?.code === 'ELOCKED') {
      noteConfigContentionRefusal('saveGlobalConfig')
      return
    }
    logForDebugging(`Failed to save config with lock: ${error}`, {
      level: 'error',
    })
    noteConfigLocklessFallback()
    let currentConfig: GlobalConfig
    try {
      currentConfig = getConfig(getGlobalMercuryFile(), createDefaultGlobalConfig)
    } catch (readError) {
      if (readError instanceof ConfigReadError) {
        logForDebugging(
          `saveGlobalConfig fallback: refusing the write — ${readError.message}`,
          { level: 'error' },
        )
        return
      }
      throw readError
    }
    if (wouldLoseAuthState(currentConfig)) {
      logForDebugging(
        'saveGlobalConfig fallback: the re-read view lost auth state the cache still holds; refusing the write (auth-wipe guard).',
        { level: 'error' },
      )
      return
    }
    const config = updater(foldPendingUpdaters(currentConfig))
    if (config === currentConfig) {
      return
    }
    written = {
      ...config,
      projects: removeProjectHistory(config.projects),
    }
    saveConfig(getGlobalMercuryFile(), written, DEFAULT_GLOBAL_CONFIG)
    writeThroughGlobalConfigCache(written)
  }
}

let globalConfigCache: { config: GlobalConfig | null; mtime: number } = {
  config: null,
  mtime: 0,
}

let globalConfigWriteCount = 0

export function getGlobalConfigWriteCount(): number {
  return globalConfigWriteCount
}

let configLocklessFallbackCount = 0

export function getConfigLocklessFallbackCount(): number {
  return configLocklessFallbackCount
}

let configContentionRefusalCount = 0

export function getConfigContentionRefusalCount(): number {
  return configContentionRefusalCount
}

export function noteConfigContentionRefusal(writer: string): void {
  configContentionRefusalCount++
  logError(
    new Error(
      `${writer}: another instance held the config lock past the whole backoff ladder; the save was refused, not written lockless (refusals this session: ${configContentionRefusalCount})`,
    ),
  )
}

export function noteConfigLocklessFallback(): void {
  configLocklessFallbackCount += 1
}

export const CONFIG_WRITE_DISPLAY_THRESHOLD = 20

function migrateConfigFields(config: GlobalConfig): GlobalConfig {
  const rewritten = rewriteRetiredGlobalConfigKeys(config)
  const projects = rewriteRetiredProjectConfigKeys(rewritten.projects)
  return projects === rewritten.projects ? rewritten : { ...rewritten, projects }
}

function removeProjectHistory(
  projects: Record<string, ProjectConfig> | undefined,
): Record<string, ProjectConfig> | undefined {
  if (!projects) {
    return projects
  }

  const cleanedProjects: Record<string, ProjectConfig> = {}
  let needsCleaning = false

  for (const [path, projectConfig] of Object.entries(projects)) {
    const legacy = projectConfig as ProjectConfig & { history?: unknown }
    if (legacy.history !== undefined) {
      needsCleaning = true
      const { history, ...cleanedConfig } = legacy
      cleanedProjects[path] = cleanedConfig
    } else {
      cleanedProjects[path] = projectConfig
    }
  }

  return needsCleaning ? cleanedProjects : projects
}

const CONFIG_FRESHNESS_POLL_MS = 1000
let freshnessWatcherStarted = false
const cacheListeners = new Set<() => void>()

function notifyGlobalConfigCache(): void {
  for (const listener of cacheListeners) listener()
}

export function subscribeGlobalConfigCache(listener: () => void): () => void {
  cacheListeners.add(listener)
  return () => {
    cacheListeners.delete(listener)
  }
}

function startGlobalConfigFreshnessWatcher(): void {
  if (freshnessWatcherStarted || process.env.NODE_ENV === 'test') return
  freshnessWatcherStarted = true
  const file = getGlobalMercuryFile()
  watchFile(
    file,
    { interval: CONFIG_FRESHNESS_POLL_MS, persistent: false },
    curr => {
      if (curr.mtimeMs <= globalConfigCache.mtime) return
      void getFsImplementation()
        .readFile(file, { encoding: 'utf-8' })
        .then(content => {
          if (curr.mtimeMs <= globalConfigCache.mtime) return
          const parsed = safeParseJSON(stripBOM(content))
          if (parsed === null || typeof parsed !== 'object') return
          globalConfigCache = {
            config: foldPendingUpdaters(migrateConfigFields({
              ...createDefaultGlobalConfig(),
              ...(parsed as Partial<GlobalConfig>),
            })),
            mtime: curr.mtimeMs,
          }
          notifyGlobalConfigCache()
        })
        .catch(() => {})
    },
  )
  registerCleanup(async () => {
    unwatchFile(file)
    freshnessWatcherStarted = false
  })
}

export function writeThroughGlobalConfigCache(config: GlobalConfig): void {
  globalConfigCache = { config, mtime: Date.now() }
}

export function getGlobalConfigCacheStamp(): number {
  return globalConfigCache.mtime
}

export function getGlobalConfig(): GlobalConfig {
  if (process.env.NODE_ENV === 'test') {
    return TEST_GLOBAL_CONFIG_FOR_TESTING
  }

  if (globalConfigCache.config) {
    return globalConfigCache.config
  }

  try {
    let stats: { mtimeMs: number; size: number } | null = null
    try {
      stats = getFsImplementation().statSync(getGlobalMercuryFile())
    } catch {
    }
    const config = migrateConfigFields(
      getConfig(getGlobalMercuryFile(), createDefaultGlobalConfig),
    )
    globalConfigCache = {
      config,
      mtime: stats?.mtimeMs ?? Date.now(),
    }
    startGlobalConfigFreshnessWatcher()
    return config
  } catch {
    return migrateConfigFields(
      getConfig(getGlobalMercuryFile(), createDefaultGlobalConfig),
    )
  }
}

export function saveConfig<A extends object>(
  file: string,
  config: A,
  defaultConfig: A,
): void {
  const dir = dirname(file)
  const fs = getFsImplementation()
  fs.mkdirSync(dir)

  const filteredConfig = pickBy(
    config,
    (value: A[keyof A], key: string) =>
      jsonStringify(value) !== jsonStringify(defaultConfig[key as keyof A]),
  )
  writeFileSyncAndFlush_DEPRECATED(
    file,
    jsonStringify(filteredConfig, null, 2),
    {
      encoding: 'utf-8',
      mode: 0o600,
    },
  )
  if (file === getGlobalMercuryFile()) {
    globalConfigWriteCount++
    writeThroughGlobalConfigCache(config as GlobalConfig)
    pendingDeferredUpdaters = []
  }
}

export async function runExclusiveOnFileSync<T>(file: string, section: () => Promise<T>): Promise<T> {
  let release: (() => void) | undefined
  try {
    let lastContention: unknown
    for (let attempt = 0; attempt < 12; attempt++) {
      try {
        release = lockfile.lockSync(file, {
          lockfilePath: `${file}.lock`,
          realpath: false,
          onCompromised: (err: Error) => {
            logForDebugging(`Config lock compromised: ${err}`, { level: 'error' })
          },
        })
        lastContention = undefined
        break
      } catch (err) {
        if ((err as NodeJS.ErrnoException | null)?.code !== 'ELOCKED') {
          lastContention = undefined
          break
        }
        lastContention = err
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.min(1000, 15 * 2 ** attempt))
      }
    }
    if (lastContention !== undefined) throw lastContention
    return await section()
  } finally {
    try {
      release?.()
    } catch {
    }
  }
}

function backupOutgoingConfig(file: string, fs: ReturnType<typeof getFsImplementation>): void {
  try {
    const fileBase = basename(file)
    const backupDir = getConfigBackupDir()

    try {
      fs.mkdirSync(backupDir)
    } catch (mkdirErr) {
      const mkdirCode = getErrnoCode(mkdirErr)
      if (mkdirCode !== 'EEXIST') {
        throw mkdirErr
      }
    }

    const MIN_BACKUP_INTERVAL_MS = 60_000
    const existingBackups = fs
      .readdirStringSync(backupDir)
      .filter(f => f.startsWith(`${fileBase}.backup.`))
      .sort()
      .reverse()

    const mostRecentBackup = existingBackups[0]
    const mostRecentTimestamp = mostRecentBackup
      ? Number(mostRecentBackup.split('.backup.').pop())
      : 0
    const shouldCreateBackup =
      Number.isNaN(mostRecentTimestamp) ||
      Date.now() - mostRecentTimestamp >= MIN_BACKUP_INTERVAL_MS

    if (shouldCreateBackup) {
      const backupPath = join(backupDir, `${fileBase}.backup.${Date.now()}`)
      fs.copyFileSync(file, backupPath)
    }

    const MAX_BACKUPS = 5
    const backupsForCleanup = shouldCreateBackup
      ? fs
          .readdirStringSync(backupDir)
          .filter(f => f.startsWith(`${fileBase}.backup.`))
          .sort()
          .reverse()
      : existingBackups

    for (const oldBackup of backupsForCleanup.slice(MAX_BACKUPS)) {
      try {
        fs.unlinkSync(join(backupDir, oldBackup))
      } catch {
      }
    }
  } catch (e) {
    const code = getErrnoCode(e)
    if (code !== 'ENOENT') {
      logForDebugging(`Failed to backup config: ${e}`, {
        level: 'error',
      })
    }
  }
}

export function saveConfigWithLock<A extends object>(
  file: string,
  createDefault: () => A,
  mergeFn: (current: A) => A,
  waitForLock = true,
): boolean {
  const defaultConfig = createDefault()
  const dir = dirname(file)
  const fs = getFsImplementation()

  fs.mkdirSync(dir)

  backupOutgoingConfig(file, fs)

  let release
  try {
    const lockFilePath = `${file}.lock`
    const startTime = Date.now()
    const takeLock = (): (() => void) =>
      lockfile.lockSync(file, {
        lockfilePath: lockFilePath,
        realpath: false,
        onCompromised: (err: Error) => {
          logForDebugging(`Config lock compromised: ${err}`, { level: 'error' })
        },
      })
    release = (() => {
      let lastContention: unknown
      for (let attempt = 0; attempt < 12; attempt++) {
        try {
          return takeLock()
        } catch (err) {
          if (!waitForLock || (err as NodeJS.ErrnoException | null)?.code !== 'ELOCKED') throw err
          lastContention = err
          const backoffMs = Math.min(1000, 15 * 2 ** attempt)
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, backoffMs)
        }
      }
      throw lastContention
    })()
    const lockTime = Date.now() - startTime
    if (lockTime > 100) {
      logForDebugging(
        'Lock acquisition took longer than expected - another Mercury instance may be running',
      )
    }

    const currentConfig = getConfig(file, createDefault)
    if (file === getGlobalMercuryFile() && wouldLoseAuthState(currentConfig)) {
      logForDebugging(
        'saveConfigWithLock: the re-read view lost auth state the cache still holds; refusing the write (auth-wipe guard).',
        { level: 'error' },
      )
      return false
    }

    const mergedConfig = mergeFn(file === getGlobalMercuryFile()
      ? foldPendingUpdaters(currentConfig as GlobalConfig) as A
      : currentConfig)

    if (mergedConfig === currentConfig) {
      return false
    }

    const filteredConfig = pickBy(
      mergedConfig,
      (value: A[keyof A], key: string) =>
        jsonStringify(value) !== jsonStringify(defaultConfig[key as keyof A]),
    )

    writeFileSyncAndFlush_DEPRECATED(
      file,
      jsonStringify(filteredConfig, null, 2),
      {
        encoding: 'utf-8',
        mode: 0o600,
      },
    )
    if (file === getGlobalMercuryFile()) {
      globalConfigWriteCount++
      writeThroughGlobalConfigCache(mergedConfig as GlobalConfig)
      pendingDeferredUpdaters = []
    }
    return true
  } finally {
    if (release) {
      release()
    }
  }
}

let configReadingAllowed = false

export function isConfigReadingAllowed(): boolean {
  return configReadingAllowed || process.env.NODE_ENV === 'test'
}

export function enableConfigs(): void {
  if (configReadingAllowed) {
    return
  }

  const startTime = Date.now()
  logForDiagnosticsNoPII('info', 'enable_configs_started')

  configReadingAllowed = true
  getConfig(
    getGlobalMercuryFile(),
    createDefaultGlobalConfig,
    true ,
  )

  logForDiagnosticsNoPII('info', 'enable_configs_completed', {
    duration_ms: Date.now() - startTime,
  })
}

export function getConfigBackupDir(): string {
  return join(getMercuryHome(), 'backups')
}

export function restoreConfigFromBackup(file: string, backupPath: string): { quarantinePath: string | null } {
  let quarantinePath: string | null = null
  try {
    const dir = getConfigBackupDir()
    mkdirSync(dir, { recursive: true })
    quarantinePath = join(dir, `${basename(file)}.corrupted.restore-${Date.now()}`)
    copyFileSync(file, quarantinePath)
  } catch {
    quarantinePath = null
  }
  copyFileSync(backupPath, file)
  return { quarantinePath }
}

export function findMostRecentBackup(file: string): string | null {
  const fs = getFsImplementation()
  const fileBase = basename(file)
  const backupDir = getConfigBackupDir()

  try {
    const backups = fs
      .readdirStringSync(backupDir)
      .filter(f => f.startsWith(`${fileBase}.backup.`))
      .sort()

    const mostRecent = backups.at(-1)
    if (mostRecent) {
      return join(backupDir, mostRecent)
    }
  } catch {
  }

  const fileDir = dirname(file)

  try {
    const backups = fs
      .readdirStringSync(fileDir)
      .filter(f => f.startsWith(`${fileBase}.backup.`))
      .sort()

    const mostRecent = backups.at(-1)
    if (mostRecent) {
      return join(fileDir, mostRecent)
    }

    const legacyBackup = `${file}.backup`
    try {
      fs.statSync(legacyBackup)
      return legacyBackup
    } catch {
    }
  } catch {
  }

  return null
}

let insideGetConfig = false

export function getConfig<A>(
  file: string,
  createDefault: () => A,
  throwOnInvalid?: boolean,
): A {
  if (!configReadingAllowed && process.env.NODE_ENV !== 'test') {
    throw new Error('Config accessed before allowed.')
  }

  const fs = getFsImplementation()

  try {
    const fileContent = fs.readFileSync(file, {
      encoding: 'utf-8',
    })
    try {
      const parsedConfig = jsonParse(stripBOM(fileContent))
      return {
        ...createDefault(),
        ...parsedConfig,
      }
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error)
      throw new ConfigParseError(errorMessage, file, createDefault())
    }
  } catch (error) {
    const errCode = getErrnoCode(error)
    if (errCode === 'ENOENT' || errCode === 'ENOTDIR') {
      const backupPath = findMostRecentBackup(file)
      if (backupPath) {
        process.stderr.write(
          `\nMercury configuration file not found at: ${file}\n` +
            `A backup file exists at: ${backupPath}\n` +
            `You can manually restore it by running: cp "${backupPath}" "${file}"\n\n`,
        )
      }
      return createDefault()
    }

    if (error instanceof ConfigParseError && throwOnInvalid) {
      throw error
    }

    if (!(error instanceof ConfigParseError)) {
      const readError = new ConfigReadError(file, errCode ?? 'EUNKNOWN', error)
      logForDebugging(readError.message, { level: 'error' })
      throw readError
    }

    if (error instanceof ConfigParseError) {
      logForDebugging(
        `Config file corrupted, resetting to defaults: ${error.message}`,
        { level: 'error' },
      )

      if (!insideGetConfig) {
        insideGetConfig = true
        try {
          logError(error)
        } finally {
          insideGetConfig = false
        }
      }

      process.stderr.write(
        `\nMercury configuration file at ${file} is corrupted: ${error.message}\n`,
      )

      const fileBase = basename(file)
      const corruptedBackupDir = getConfigBackupDir()

      try {
        fs.mkdirSync(corruptedBackupDir)
      } catch (mkdirErr) {
        const mkdirCode = getErrnoCode(mkdirErr)
        if (mkdirCode !== 'EEXIST') {
          throw mkdirErr
        }
      }

      const existingCorruptedBackups = fs
        .readdirStringSync(corruptedBackupDir)
        .filter(f => f.startsWith(`${fileBase}.corrupted.`))

      let corruptedBackupPath: string | undefined
      let alreadyBackedUp = false

      const currentContent = fs.readFileSync(file, { encoding: 'utf-8' })
      for (const backup of existingCorruptedBackups) {
        try {
          const backupContent = fs.readFileSync(
            join(corruptedBackupDir, backup),
            { encoding: 'utf-8' },
          )
          if (currentContent === backupContent) {
            alreadyBackedUp = true
            break
          }
        } catch {
        }
      }

      if (!alreadyBackedUp) {
        corruptedBackupPath = join(
          corruptedBackupDir,
          `${fileBase}.corrupted.${Date.now()}`,
        )
        try {
          fs.copyFileSync(file, corruptedBackupPath)
          logForDebugging(
            `Corrupted config backed up to: ${corruptedBackupPath}`,
            {
              level: 'error',
            },
          )
        } catch {
        }
      }

      const backupPath = findMostRecentBackup(file)
      if (corruptedBackupPath) {
        process.stderr.write(
          `The corrupted file has been backed up to: ${corruptedBackupPath}\n`,
        )
      } else if (alreadyBackedUp) {
        process.stderr.write(`The corrupted file has already been backed up.\n`)
      }

      if (backupPath) {
        process.stderr.write(
          `A backup file exists at: ${backupPath}\n` +
            `You can manually restore it by running: cp "${backupPath}" "${file}"\n\n`,
        )
      } else {
        process.stderr.write(`\n`)
      }
    }

    return createDefault()
  }
}

export const _getConfigForTesting = getConfig
export const _wouldLoseAuthStateForTesting = wouldLoseAuthState
export function _setGlobalConfigCacheForTesting(
  config: GlobalConfig | null,
): void {
  globalConfigCache.config = config
  globalConfigCache.mtime = config ? Date.now() : 0
}
