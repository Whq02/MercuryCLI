import { existsSync, statSync } from 'node:fs'
import { dirname, resolve, sep } from 'node:path'

import * as chokidar from 'chokidar'

import { getIsRemoteMode } from '../../bootstrap/state.js'
import { registerCleanup } from '../cleanupRegistry.js'
import { logForDebugging } from '../debug.js'
import { executeConfigChangeHooks, hasBlockingResult } from '../hooks.js'
import { logError } from '../log.js'
import { createSignal } from '../signal.js'
import { resolveWatchRoot } from '../watchRoot.js'
import type { SettingSource } from './constants.js'
import { SETTING_SOURCES } from './constants.js'
import { clearInternalWrites, consumeInternalWrite } from './internalWrites.js'
import { getManagedSettingsDropInDir } from './managedPath.js'
import { refreshMdmSettings, getHkcuSettings, getMdmSettings, setMdmSettingsCache } from './mdm/settings.js'
import { getSettingsFilePathForSource } from './settings.js'
import { resetSettingsCache } from './settingsCache.js'

/**
 * The process-wide settings hot-reload watcher: filesystem watching of the
 * settings files, MDM polling (registry/plist values cannot be watched),
 * and change fan-out. Watch death degrades the session; it never crashes
 * it.
 */

type TimingOverrides = {
  stabilityThresholdMs?: number
  pollIntervalMs?: number
  internalWriteWindowMs?: number
  mdmPollIntervalMs?: number
}

let stabilityThresholdMs = 1000
let pollIntervalMs = 500
let internalWriteWindowMs = 5000
let mdmPollIntervalMs = 30 * 60 * 1000

let initialized = false
let disposed = false
let watcher: chokidar.FSWatcher | null = null
let cleanupRegistered = false
let mdmPollTimer: NodeJS.Timeout | null = null
let mdmSnapshot: string | null = null
const pendingDeletions = new Map<string, NodeJS.Timeout>()
// Frozen at initialisation: a path that only becomes a settings path later
// in the session is not retro-fitted (documented residual).
let knownSettingsFiles = new Map<string, SettingSource>()
let dropInDir: string | null = null
const changeSignal = createSignal<[SettingSource]>()

/** Contract data: the config-change hook source tokens. */
function hookSourceFor(source: SettingSource): string {
  switch (source) {
    case 'userSettings':
      return 'user_settings'
    case 'projectSettings':
      return 'project_settings'
    case 'localSettings':
      return 'local_settings'
    case 'flagSettings':
    case 'policySettings':
      return 'policy_settings'
  }
}

function normalizeEventPath(eventPath: string): string {
  // Watcher paths may use forward slashes on Windows.
  return resolve(sep === '\\' ? eventPath.replace(/\//g, '\\') : eventPath)
}

function sourceForPath(eventPath: string): SettingSource | null {
  const normalized = normalizeEventPath(eventPath)
  const known = knownSettingsFiles.get(normalized)
  if (known !== undefined) return known
  // A path inside the drop-in directory maps to the policy source.
  if (dropInDir !== null && normalized.startsWith(dropInDir + sep) && normalized.endsWith('.json')) {
    return 'policySettings'
  }
  return null
}

/**
 * Fan-out ordering is a correctness requirement: the caches reset ONCE,
 * centrally, BEFORE listeners are notified — one notification means one
 * disk reload, not one per subscriber.
 */
function fanOut(source: SettingSource): void {
  resetSettingsCache()
  changeSignal.emit(source)
}

async function handleChange(eventPath: string): Promise<void> {
  const source = sourceForPath(eventPath)
  if (source === null) return
  const normalized = normalizeEventPath(eventPath)
  const pending = pendingDeletions.get(normalized)
  if (pending !== undefined) {
    // A delete-and-recreate collapses to a change.
    clearTimeout(pending)
    pendingDeletions.delete(normalized)
  }
  if (consumeInternalWrite(normalized, internalWriteWindowMs)) return
  try {
    const results = await executeConfigChangeHooks(hookSourceFor(source) as never, normalized)
    if (hasBlockingResult(results)) return
  } catch (error) {
    logForDebugging(`config-change hook failed: ${String(error)}`)
  }
  fanOut(source)
}

function handleUnlink(eventPath: string): void {
  const source = sourceForPath(eventPath)
  if (source === null) return
  const normalized = normalizeEventPath(eventPath)
  // A second delete while one is pending is ignored.
  if (pendingDeletions.has(normalized)) return
  // The grace period necessarily outlasts the write-stability check on a
  // recreated file.
  const graceMs = stabilityThresholdMs + pollIntervalMs + 250
  const timer = setTimeout(() => {
    pendingDeletions.delete(normalized)
    void (async () => {
      try {
        const results = await executeConfigChangeHooks(hookSourceFor(source) as never, normalized)
        if (hasBlockingResult(results)) return
      } catch (error) {
        logForDebugging(`config-change hook failed: ${String(error)}`)
      }
      fanOut(source)
    })()
  }, graceMs)
  timer.unref?.()
  pendingDeletions.set(normalized, timer)
}

function startMdmPolling(): void {
  // An initial snapshot of both tiers.
  mdmSnapshot = JSON.stringify({ mdm: getMdmSettings(), hkcu: getHkcuSettings() })
  mdmPollTimer = setInterval(() => {
    if (disposed) return
    void (async () => {
      try {
        const fresh = await refreshMdmSettings()
        const nextSnapshot = JSON.stringify(fresh)
        if (nextSnapshot === mdmSnapshot) return
        mdmSnapshot = nextSnapshot
        setMdmSettingsCache(fresh.mdm, fresh.hkcu)
        fanOut('policySettings')
      } catch (error) {
        logForDebugging(`MDM poll failed: ${String(error)}`)
      }
    })()
  }, mdmPollIntervalMs)
  // The timer must not keep the process alive.
  mdmPollTimer.unref?.()
}

async function initialize(): Promise<void> {
  // Order matters: guards, mark initialised, start the MDM poll, register
  // the disposer — all BEFORE the (asynchronous) watch-target computation.
  if (getIsRemoteMode()) return
  if (initialized || disposed) return
  initialized = true
  startMdmPolling()
  if (!cleanupRegistered) {
    // The disposer stays registered for the process lifetime.
    cleanupRegistered = true
    registerCleanup(async () => {
      await dispose()
    })
  }

  const files = new Map<string, SettingSource>()
  const directories = new Set<string>()
  for (const source of SETTING_SOURCES) {
    // Flag files are supplied on the command line, never change during a
    // session, and may live in temp directories with special files.
    if (source === 'flagSettings') continue
    const filePath = getSettingsFilePathForSource(source)
    if (filePath === undefined) continue
    const normalized = resolve(filePath)
    files.set(normalized, source)
    const parent = dirname(normalized)
    // EVERY existing parent directory is watched, even one holding no
    // settings file yet — otherwise a file created later is never seen.
    try {
      if (existsSync(parent)) directories.add(parent)
    } catch {
      // An unprobeable directory is simply not armed.
    }
  }
  const dropIn = getManagedSettingsDropInDir()
  try {
    if (existsSync(dropIn)) {
      dropInDir = resolve(dropIn)
      directories.add(dropIn)
    }
  } catch {
    dropInDir = null
  }
  knownSettingsFiles = files

  // A disposal that races this initialisation must win.
  if (disposed) return
  if (directories.size === 0) return

  watcher = chokidar.watch([...directories].map(resolveWatchRoot), {
    persistent: true,
    ignoreInitial: true,
    depth: 1,
    awaitWriteFinish: { stabilityThreshold: stabilityThresholdMs, pollInterval: pollIntervalMs },
    ignorePermissionErrors: true,
    atomic: true,
    ignored: (candidatePath: string, stats?: { isFile(): boolean; isDirectory(): boolean }) => {
      const normalized = normalizeEventPath(candidatePath)
      if (normalized.split(sep).includes('.git')) return true
      let fileStats = stats
      if (fileStats === undefined) {
        try {
          fileStats = statSync(normalized)
        } catch {
          // Stat-less paths are allowed through (the watcher needs them).
          return false
        }
      }
      // Special file types (sockets, FIFOs, devices) error on macOS.
      const raw = fileStats as unknown as {
        isFile(): boolean
        isDirectory(): boolean
        isSocket?(): boolean
        isFIFO?(): boolean
        isCharacterDevice?(): boolean
        isBlockDevice?(): boolean
      }
      if (raw.isSocket?.() || raw.isFIFO?.() || raw.isCharacterDevice?.() || raw.isBlockDevice?.()) return true
      if (raw.isDirectory()) return false
      if (!raw.isFile()) return false
      // A regular file passes only when it is a known settings file or a
      // drop-in *.json.
      if (knownSettingsFiles.has(normalized)) return false
      if (dropInDir !== null && normalized.startsWith(dropInDir + sep) && normalized.endsWith('.json')) {
        return false
      }
      return true
    },
  })
  watcher.on('change', path => void handleChange(path))
  watcher.on('add', path => void handleChange(path))
  watcher.on('unlink', path => handleUnlink(path))
  // An unlistened error event is an uncaught exception.
  watcher.on('error', error => {
    logError(error)
  })
}

function subscribe(listener: (source: SettingSource) => void): () => void {
  return changeSignal.subscribe(listener)
}

/** Programmatic notifications (e.g. a remote managed-settings refresh) ride the same fan-out. */
function notifyChange(source: SettingSource): void {
  fanOut(source)
}

async function dispose(): Promise<void> {
  disposed = true
  if (mdmPollTimer !== null) {
    clearInterval(mdmPollTimer)
    mdmPollTimer = null
  }
  for (const timer of pendingDeletions.values()) clearTimeout(timer)
  pendingDeletions.clear()
  mdmSnapshot = null
  clearInternalWrites()
  changeSignal.clear()
  const closing = watcher?.close() ?? Promise.resolve()
  watcher = null
  await closing
}

/**
 * Restores the pre-initialise state. Deliberately does NOT clear
 * subscribers or internal-write marks (only disposal does) — a test can
 * subscribe once and re-initialise. Returns the watcher-close promise so
 * a test can await it before deleting the watched directory.
 */
async function resetForTesting(overrides?: TimingOverrides): Promise<void> {
  if (mdmPollTimer !== null) {
    clearInterval(mdmPollTimer)
    mdmPollTimer = null
  }
  for (const timer of pendingDeletions.values()) clearTimeout(timer)
  pendingDeletions.clear()
  mdmSnapshot = null
  initialized = false
  disposed = false
  if (overrides?.stabilityThresholdMs !== undefined) stabilityThresholdMs = overrides.stabilityThresholdMs
  if (overrides?.pollIntervalMs !== undefined) pollIntervalMs = overrides.pollIntervalMs
  if (overrides?.internalWriteWindowMs !== undefined) internalWriteWindowMs = overrides.internalWriteWindowMs
  if (overrides?.mdmPollIntervalMs !== undefined) mdmPollIntervalMs = overrides.mdmPollIntervalMs
  const closing = watcher?.close() ?? Promise.resolve()
  watcher = null
  await closing
}

/**
 * THE GROUND-MOVE RE-ARM (the never-stale law): the watch targets are
 * computed at initialisation from the settings paths, and the project/local
 * paths derive from the harness ground — a ground move (applyHarnessGround)
 * re-homes them, so the watcher must re-arm on the NEW paths or a new
 * ground's settings edit never fans out. Subscribers and internal-write
 * marks survive (the resetForTesting law); the MDM poll restarts rather
 * than doubling. No-op before the first initialisation (nothing is armed
 * yet — the boot path will arm on the right ground) and after disposal.
 */
async function reground(): Promise<void> {
  if (!initialized || disposed) return
  if (mdmPollTimer !== null) {
    clearInterval(mdmPollTimer)
    mdmPollTimer = null
  }
  for (const timer of pendingDeletions.values()) clearTimeout(timer)
  pendingDeletions.clear()
  mdmSnapshot = null
  const closing = watcher?.close() ?? Promise.resolve()
  watcher = null
  initialized = false
  await closing
  await initialize()
}

/** Test seam: the armed settings-file targets (absolute paths). */
export function _watchTargetsForTesting(): string[] {
  return [...knownSettingsFiles.keys()]
}

export { initialize, dispose, subscribe, notifyChange, reground, resetForTesting }

export const settingsChangeDetector = {
  initialize,
  dispose,
  subscribe,
  notifyChange,
  reground,
  resetForTesting,
}
