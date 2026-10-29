import { copyFileSync, mkdirSync, unwatchFile, watchFile } from 'fs'
import pickBy from 'lodash-es/pickBy.js'
import { basename, dirname, join } from 'path'
import { registerCleanup } from '../cleanupRegistry.js'
import { logForDebugging } from '../debug.js'
import { logForDiagnosticsNoPII } from '../diagLogs.js'
import { getGlobalMercuryFile } from '../env.js'
import { getMercuryHome } from '../envUtils.js'
import { ConfigParseError, ConfigReadError, getErrnoCode } from '../errors.js'
import { isReadOnlyDiagnostic } from '../diagnosticReadOnly.js'
import { writeFileAndFlushAtomically } from '../file.js'
import { getFsImplementation } from '../fsOperations.js'
import { safeParseJSON } from '../json.js'
import { stripBOM } from '../jsonRead.js'
import * as lockfile from '../lockfile.js'
import { logError } from '../log.js'
import { jsonParse, jsonStringify } from '../slowOperations.js'

import {
  createDefaultGlobalConfig,
  DEFAULT_GLOBAL_CONFIG,
  type GlobalConfig,
} from './schema.js'

const TEST_GLOBAL_CONFIG_FOR_TESTING: GlobalConfig = {
  ...DEFAULT_GLOBAL_CONFIG,
}

type AuthStateView = { oauthAccount?: unknown; hasCompletedOnboarding?: boolean }

const authStateLosses: ReadonlyArray<(cached: AuthStateView, fresh: AuthStateView) => boolean> = [
  (cached, fresh) => cached.oauthAccount !== undefined && fresh.oauthAccount === undefined,
  (cached, fresh) => cached.hasCompletedOnboarding === true && fresh.hasCompletedOnboarding !== true,
]

export function wouldLoseAuthState(fresh: AuthStateView): boolean {
  const cached = globalConfigCache.config
  return !!cached && authStateLosses.some(lost => lost(cached, fresh))
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
  return folded
}

export function saveGlobalConfigDeferred(
  updater: (currentConfig: GlobalConfig) => GlobalConfig,
): void {
  if (isReadOnlyDiagnostic()) return
  if (process.env.NODE_ENV === 'test') {
    saveGlobalConfig(updater)
    return
  }
  const current = getGlobalConfig()
  const next = updater(current)
  if (next === current) return
  pendingDeferredUpdaters.push(updater)
  armDeferredExitFlush()
  writeThroughGlobalConfigCache(next)
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
  if (isReadOnlyDiagnostic()) return
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
        written = config
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
    written = config
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

type ConfigFieldShape = 'boolean' | 'number' | 'string' | 'list' | 'object'

export type GlobalConfigFieldDrop = { field: string; expected: ConfigFieldShape; found: string }

const OPTIONAL_GLOBAL_CONFIG_FIELD_SHAPES: Record<string, ConfigFieldShape> = {
  claudeAiMcpEverConnected: 'list',
  concourseEnabled: 'boolean',
  backgroundSessionsLaunchCrewmates: 'boolean',
  duckduckgoScraping: 'boolean',
  localModelWindows: 'object',
  localModelBatch: 'object',
}

function configFieldShapeOf(value: unknown): ConfigFieldShape | null {
  if (typeof value === 'boolean') return 'boolean'
  if (typeof value === 'number') return 'number'
  if (typeof value === 'string') return 'string'
  if (Array.isArray(value)) return 'list'
  if (value !== null && typeof value === 'object') return 'object'
  return null
}

export function configShapeWords(shape: ConfigFieldShape): string {
  return shape === 'string' ? 'text' : shape === 'object' ? 'an object' : `a ${shape}`
}

function configValueWords(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'a list'
  if (typeof value === 'object') return 'an object'
  if (typeof value === 'string') return `the text ${JSON.stringify(value)}`
  return `the ${typeof value} ${String(value)}`
}

let globalConfigFieldDrops: GlobalConfigFieldDrop[] = []
let namedGlobalConfigFieldDrops = ''

export function getGlobalConfigFieldDrops(): readonly GlobalConfigFieldDrop[] {
  return globalConfigFieldDrops
}

export function decodeGlobalConfigFields(parsed: unknown): unknown {
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return parsed
  const defaults = createDefaultGlobalConfig() as unknown as Record<string, unknown>
  const source = parsed as Record<string, unknown>
  const drops: GlobalConfigFieldDrop[] = []
  let out: Record<string, unknown> | null = null
  for (const [key, value] of Object.entries(source)) {
    const expected = key in defaults ? configFieldShapeOf(defaults[key]) : (OPTIONAL_GLOBAL_CONFIG_FIELD_SHAPES[key] ?? null)
    if (expected === null) continue
    if (configFieldShapeOf(value) !== expected) {
      out ??= { ...source }
      delete out[key]
      drops.push({ field: key, expected, found: configValueWords(value) })
      continue
    }
    if (expected !== 'object' || !(key in defaults)) continue
    const nestedDefaults = defaults[key] as Record<string, unknown>
    const nested = value as Record<string, unknown>
    let nestedOut: Record<string, unknown> | null = null
    for (const [nestedKey, nestedValue] of Object.entries(nested)) {
      const nestedExpected = nestedKey in nestedDefaults ? configFieldShapeOf(nestedDefaults[nestedKey]) : null
      if (nestedExpected === null || configFieldShapeOf(nestedValue) === nestedExpected) continue
      nestedOut ??= { ...nested }
      delete nestedOut[nestedKey]
      drops.push({ field: `${key}.${nestedKey}`, expected: nestedExpected, found: configValueWords(nestedValue) })
    }
    if (nestedOut !== null) {
      out ??= { ...source }
      out[key] = nestedOut
    }
  }
  globalConfigFieldDrops = drops
  const named = drops.map(d => d.field).join(',')
  if (drops.length > 0 && named !== namedGlobalConfigFieldDrops) {
    logForDebugging(
      `global config: ${drops.length} field(s) ignored for their shape and read as their defaults: ${drops.map(d => `${d.field} expected ${configShapeWords(d.expected)}, found ${d.found}`).join('; ')}`,
      { level: 'warn' },
    )
  }
  namedGlobalConfigFieldDrops = named
  return out ?? parsed
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

function acceptConfigRefresh(content: string, stamp: number): void {
  if (stamp <= globalConfigCache.mtime) return
  const fields = safeParseJSON(stripBOM(content))
  if (fields === null || typeof fields !== 'object') return
  const config = foldPendingUpdaters({ ...createDefaultGlobalConfig(), ...(decodeGlobalConfigFields(fields) as Partial<GlobalConfig>) })
  globalConfigCache = { config, mtime: stamp }
  notifyGlobalConfigCache()
}

function configRefreshListener(file: string): (current: { mtimeMs: number }) => void {
  return current => {
    if (current.mtimeMs <= globalConfigCache.mtime) return
    void getFsImplementation().readFile(file, { encoding: 'utf-8' })
      .then(content => acceptConfigRefresh(content, current.mtimeMs))
      .catch(() => {})
  }
}

function startGlobalConfigFreshnessWatcher(): void {
  if (process.env.NODE_ENV === 'test' || freshnessWatcherStarted) return
  freshnessWatcherStarted = true
  const path = getGlobalMercuryFile()
  watchFile(path, { interval: CONFIG_FRESHNESS_POLL_MS, persistent: false }, configRefreshListener(path))
  registerCleanup(async () => {
    unwatchFile(path)
    freshnessWatcherStarted = false
  })
}

export function writeThroughGlobalConfigCache(config: GlobalConfig): void {
  globalConfigCache = { config, mtime: Date.now() }
}

export function readGlobalConfigAgain(): void {
  const file = getGlobalMercuryFile()
  let stamp: number
  let content: string
  try {
    stamp = getFsImplementation().statSync(file).mtimeMs
    content = String(getFsImplementation().readFileSync(file, { encoding: 'utf-8' }))
  } catch {
    return
  }
  const parsed = safeParseJSON(stripBOM(content))
  if (parsed === null || typeof parsed !== 'object') return
  globalConfigCache = {
    config: foldPendingUpdaters({ ...createDefaultGlobalConfig(), ...(decodeGlobalConfigFields(parsed) as Partial<GlobalConfig>) }),
    mtime: stamp,
  }
  notifyGlobalConfigCache()
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
    const config = getConfig(getGlobalMercuryFile(), createDefaultGlobalConfig)
    globalConfigCache = {
      config,
      mtime: stats?.mtimeMs ?? Date.now(),
    }
    startGlobalConfigFreshnessWatcher()
    return config
  } catch {
    return getConfig(getGlobalMercuryFile(), createDefaultGlobalConfig)
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
  writeFileAndFlushAtomically(
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

function prepareConfigBackupHome(disk: ReturnType<typeof getFsImplementation>): string {
  const directory = getConfigBackupDir()
  try {
    disk.mkdirSync(directory)
  } catch (failure) {
    if (getErrnoCode(failure) !== 'EEXIST') throw failure
  }
  return directory
}

function stampedCopies(disk: ReturnType<typeof getFsImplementation>, directory: string, prefix: string): string[] {
  return disk.readdirStringSync(directory).filter(name => name.startsWith(prefix)).sort().reverse()
}

function backupOutgoingConfig(file: string, fs: ReturnType<typeof getFsImplementation>): void {
  try {
    const stem = basename(file)
    const directory = prepareConfigBackupHome(fs)
    const prefix = `${stem}.backup.`
    let copies = stampedCopies(fs, directory, prefix)
    const stamp = copies.length ? Number(copies[0]!.split('.backup.').at(-1)) : 0
    if (Number.isNaN(stamp) || Date.now() - stamp >= 60000) {
      fs.copyFileSync(file, join(directory, prefix + Date.now()))
      copies = stampedCopies(fs, directory, prefix)
    }
    copies.slice(5).forEach(name => {
      try { fs.unlinkSync(join(directory, name)) } catch {}
    })
  } catch (failure) {
    if (getErrnoCode(failure) !== 'ENOENT') logForDebugging(`Failed to backup config: ${failure}`, { level: 'error' })
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

    writeFileAndFlushAtomically(
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
  const prefix = `${basename(file)}.backup.`
  const newestNamed = (names: readonly string[]): string | null =>
    names.reduce<string | null>(
      (best, name) => name.startsWith(prefix) && (best === null || name > best) ? name : best,
      null,
    )
  const listing = (dir: string): string[] | null => {
    try {
      return fs.readdirStringSync(dir)
    } catch {
      return null
    }
  }
  const inBackupHome = (): string | null => {
    const home = getConfigBackupDir()
    const newest = newestNamed(listing(home) ?? [])
    return newest === null ? null : join(home, newest)
  }
  const besideTheFile = (): string | null => {
    const dir = dirname(file)
    const names = listing(dir)
    if (names === null) return null
    const newest = newestNamed(names)
    if (newest !== null) return join(dir, newest)
    const bare = `${file}.backup`
    try {
      fs.statSync(bare)
    } catch {
      return null
    }
    return bare
  }
  return inBackupHome() ?? besideTheFile()
}

let insideGetConfig = false

function decodeConfigRead<A>(file: string, text: string, defaults: () => A): A {
  try {
    const value = jsonParse(stripBOM(text))
    const fields = file === getGlobalMercuryFile() ? decodeGlobalConfigFields(value) : value
    return { ...defaults(), ...(fields as Partial<A>) }
  } catch (failure) {
    throw new ConfigParseError(failure instanceof Error ? failure.message : String(failure), file, defaults())
  }
}

function quarantineConfigRead(file: string, disk: ReturnType<typeof getFsImplementation>): { directory: string; copy?: string; matched: boolean } {
  const stem = basename(file)
  const directory = prepareConfigBackupHome(disk)
  const names = disk.readdirStringSync(directory).filter(name => name.startsWith(`${stem}.corrupted.`))
  const bytes = disk.readFileSync(file, { encoding: 'utf-8' })
  const matched = names.some(name => {
    try { return disk.readFileSync(join(directory, name), { encoding: 'utf-8' }) === bytes } catch { return false }
  })
  if (matched) return { directory, matched }
  const copy = join(directory, `${stem}.corrupted.${Date.now()}`)
  try {
    disk.copyFileSync(file, copy)
    logForDebugging(`Corrupted config backed up to: ${copy}`, { level: 'error' })
  } catch {}
  return { directory, copy, matched }
}

function reportConfigCorruption(file: string, error: ConfigParseError, disk: ReturnType<typeof getFsImplementation>): void {
  if (!insideGetConfig) {
    insideGetConfig = true
    try { logError(error) } finally { insideGetConfig = false }
  }
  process.stderr.write(`\nThe configuration file ${file} is not valid JSON (${error.message}); defaults are in use for this run.\n`)
  const kept = quarantineConfigRead(file, disk)
  const backup = findMostRecentBackup(file)
  const location = kept.copy
    ? `The unreadable bytes were kept at ${kept.copy}\n`
    : kept.matched ? `The unreadable bytes were already kept under ${kept.directory}\n` : ''
  const restore = backup ? `The newest good copy is ${backup}; to bring it back: cp "${backup}" "${file}"\n` : ''
  process.stderr.write(`${location}${restore}\n`)
}

export function getConfig<A>(file: string, createDefault: () => A, throwOnInvalid?: boolean): A {
  if (!configReadingAllowed && process.env.NODE_ENV !== 'test') throw new Error('Config accessed before allowed.')
  const disk = getFsImplementation()
  try {
    return decodeConfigRead(file, disk.readFileSync(file, { encoding: 'utf-8' }), createDefault)
  } catch (failure) {
    const code = getErrnoCode(failure)
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      const backup = findMostRecentBackup(file)
      if (backup) process.stderr.write(`\nNo configuration file at ${file}; defaults are in use.\nThe newest backup is ${backup}; to bring it back: cp "${backup}" "${file}"\n\n`)
      return createDefault()
    }
    if (!(failure instanceof ConfigParseError)) {
      const unreadable = new ConfigReadError(file, code ?? 'EUNKNOWN', failure)
      logForDebugging(unreadable.message, { level: 'error' })
      throw unreadable
    }
    if (throwOnInvalid) throw failure
    reportConfigCorruption(file, failure, disk)
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
