import { copyFileSync, mkdirSync, unwatchFile, watchFile } from 'fs'
import pickBy from 'lodash-es/pickBy.js'
import { basename, dirname, join } from 'path'
import { registerCleanup } from '../cleanupRegistry.js'
import { logForDebugging } from '../debug.js'
import { logForDiagnosticsNoPII } from '../diagLogs.js'
import { getGlobalMercuryFile } from '../env.js'
import { getMercuryHome } from '../envUtils.js'
import { ConfigParseError, ConfigReadError, errorMessage, getErrnoCode } from '../errors.js'
import { isReadOnlyDiagnostic } from '../diagnosticReadOnly.js'
import { AtomicWriteRefusal, writeFileAndFlushAtomically } from '../file.js'
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
import { sleep } from '../sleep.js'
import { passedOver } from '../passedOver.js'
import { sleepSync } from '../timers.js'
import { notBuilt, unbuilt } from '../../pi/holes.js'

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
let globalConfigRefusalSaid = false

export function noteGlobalConfigRefusalSaid(): void {
  globalConfigRefusalSaid = true
}

type GlobalConfigSaveRefusal =
  | { kind: 'read'; filePath: string; code: string }
  | { kind: 'locked'; filePath: string }
  | { kind: 'auth-wipe'; filePath: string }

function exitFlushRefusalLine(refusal: GlobalConfigSaveRefusal): string {
  switch (refusal.kind) {
    case 'read':
      return `Could not save the settings changed in this session: ${refusal.filePath} could not be read (${refusal.code}); nothing was written and those changes were lost. Close what holds the file, then try again.`
    case 'locked':
      return `Could not save the settings changed in this session: ${refusal.filePath} could not be written (another Mercury kept its lock); nothing was written and those changes were lost. Close what holds the file, then try again.`
    case 'auth-wipe':
      return `Could not save the settings changed in this session: ${refusal.filePath} was not written over (it read back without the sign-in this session holds); nothing was written and those changes were lost. Set them again next time.`
  }
}

function armDeferredExitFlush(): void {
  if (deferredExitFlushArmed) return
  deferredExitFlushArmed = true
  process.once('exit', () => {
    const alreadyReported = globalConfigRefusalSaid
    try {
      if (hasPendingDeferredGlobalConfigSaves()) {
        const refusal = saveGlobalConfigOutcome(current => current)
        if (refusal !== null && !alreadyReported) {
          process.stderr.write(`\n${exitFlushRefusalLine(refusal)}\n`)
        }
      }
    } catch (error) {
      if (!alreadyReported) {
        if (error instanceof AtomicWriteRefusal && error.phase === 'rename') {
          logForDebugging(`Failed to save session settings to ${error.targetPath}: ${error.message}`, { level: 'error' })
          const code = error.code ?? 'write error'
          process.stderr.write(
            `\nCould not save the settings changed in this session: ${error.targetPath} could not be written (${code}); nothing was written and those changes were lost. Close what holds the file, then try again.\n`,
          )
        } else {
          process.stderr.write(`\nThe settings changed in this session could not be saved to ${getGlobalMercuryFile()} (${errorMessage(error)}); they are lost — set them again next time.\n`)
        }
      }
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
      await sleep(Math.min(1000, 15 * 2 ** attempt))
    }
  }
  if (pendingDeferredUpdaters.length > 0) noteConfigContentionRefusal('flushDeferredGlobalConfigSaves')
}

export function hasPendingDeferredGlobalConfigSaves(): boolean {
  return pendingDeferredUpdaters.length > 0
}

function saveGlobalConfigOutcome(
  updater: (currentConfig: GlobalConfig) => GlobalConfig,
): GlobalConfigSaveRefusal | null {
  return notBuilt('src/utils/config/globalConfig.ts:140')
}

export function saveGlobalConfig(
  updater: (currentConfig: GlobalConfig) => GlobalConfig,
): void {
  return notBuilt('src/utils/config/globalConfig.ts:221')
}

let globalConfigCache: { config: GlobalConfig | null; mtime: number } = unbuilt('src/utils/config/globalConfig.ts:227')

export function getGlobalConfigWriteCount(): number {
  return notBuilt('src/utils/config/globalConfig.ts:234')
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
  helperModel: 'object',
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
  const defaults: Record<string, unknown> = createDefaultGlobalConfig()
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

export function writeThroughGlobalConfigCache(config: GlobalConfig): void {
  return notBuilt('src/utils/config/globalConfig.ts:394')
}

export function readGlobalConfigAgain(): void {
  return notBuilt('src/utils/config/globalConfig.ts:398')
}

export function getGlobalConfigCacheStamp(): number {
  return notBuilt('src/utils/config/globalConfig.ts:418')
}

export function getGlobalConfig(): GlobalConfig {
  return notBuilt('src/utils/config/globalConfig.ts:422')
}

export function saveConfig<A extends object>(
  file: string,
  config: A,
  defaultConfig: A,
): void {
  return notBuilt('src/utils/config/globalConfig.ts:450')
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
        sleepSync(Math.min(1000, 15 * 2 ** attempt))
      }
    }
    if (lastContention !== undefined) throw lastContention
    return await section()
  } finally {
    try {
      release?.()
    } catch (error) {
      passedOver(error)
      logForDebugging(`Failed to release config lock for ${file}: ${error}`, { level: 'error' })
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

export function saveConfigWithLock<A extends object>(
  file: string,
  createDefault: () => A,
  mergeFn: (current: A) => A,
  waitForLock?: boolean,
): boolean {
  return notBuilt('src/utils/config/globalConfig.ts:640')
}

let configReadingAllowed: boolean = unbuilt('src/utils/config/globalConfig.ts:649')

export function isConfigReadingAllowed(): boolean {
  return notBuilt('src/utils/config/globalConfig.ts:651')
}

export function enableConfigs(): void {
  return notBuilt('src/utils/config/globalConfig.ts:655')
}

export function getConfigBackupDir(): string {
  return notBuilt('src/utils/config/globalConfig.ts:675')
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
    } catch (error) {
      passedOver(error)
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
    } catch (error) {
      passedOver(error)
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
    try { return disk.readFileSync(join(directory, name), { encoding: 'utf-8' }) === bytes } catch (error) { passedOver(error); return false }
  })
  if (matched) return { directory, matched }
  const copy = join(directory, `${stem}.corrupted.${Date.now()}`)
  try {
    disk.copyFileSync(file, copy)
    logForDebugging(`Corrupted config backed up to: ${copy}`, { level: 'error' })
    return { directory, copy, matched }
  } catch (error) {
    logForDebugging(`Failed to back up corrupted config to ${copy}: ${error}`, { level: 'error' })
    return { directory, matched }
  }
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

export class ConfigAccessBeforeAllowedError extends Error {
  constructor() {
    super('Config accessed before allowed.')
    this.name = 'ConfigAccessBeforeAllowedError'
  }
}

export function getConfig<A>(file: string, createDefault: () => A, throwOnInvalid?: boolean): A {
  if (!configReadingAllowed && process.env.NODE_ENV !== 'test') throw new ConfigAccessBeforeAllowedError()
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
