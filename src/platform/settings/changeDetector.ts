import { existsSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import { getCwd } from '../files/cwd.js'
import { findGitRoot } from '../git/git.js'
import { projectConfigDirs } from './projectConfig.js'

import * as chokidar from 'chokidar'

import { getIsRemoteMode } from '../../boot/process-state/processState.js'
import { registerCleanup } from '../processes/cleanupRegistry.js'
import { logForDebugging } from '../logs/debugLog.js'
import { logError } from '../logs/errorLog.js'
import { createSignal } from '../async/signal.js'
import { ignoringSpecialFiles, resolveWatchRoot } from '../processes/watchRoot.js'
import type { SettingSource } from './settingSources.js'
import { SETTING_SOURCES } from './settingSources.js'
import { clearInternalWrites, consumeInternalWrite } from './internalWrites.js'
import { getManagedSettingsDropInDir } from './managedPath.js'
import { refreshMdmSettings, getHkcuSettings, getMdmSettings, setMdmSettingsCache } from './mdm/settings.js'
import { getSettingsFilePathForSource } from './settings.js'
import { resetSettingsCache } from './settingsCache.js'
import { passedOver } from '../errors/passedOver.js'
import { startInterval, startTimeout, stopInterval, stopTimeout } from '../async/timers.js'


type TimingOverrides = {
  stabilityThresholdMs?: number
  pollIntervalMs?: number
  internalWriteWindowMs?: number
  mdmPollIntervalMs?: number
  bunPollIntervalMs?: number
}

let stabilityThresholdMs = 1000
let pollIntervalMs = 500
let internalWriteWindowMs = 5000
let mdmPollIntervalMs = 30 * 60 * 1000
let bunPollIntervalMs = 1000

let initialized: boolean = false
let disposed: boolean = false
let cleanupRegistered: boolean = false
let watcher: chokidar.FSWatcher | null = null
let mdmPollTimer: NodeJS.Timeout | null = null
let mdmSnapshot: string | null = null
const pendingDeletions: Map<string, NodeJS.Timeout> = new Map()
let knownSettingsFiles: Map<string, SettingSource> = new Map()
let dropInDir: string | null = null
let watchedRoots = new Set<string>()
let awaitedParents = new Set<string>()
const changeSignal = createSignal<[SettingSource]>()
const PROJECT_SOURCES: ReadonlySet<SettingSource> = new Set<SettingSource>(['projectSettings', 'localSettings'])

function projectWatchRoots(cwd: string): string[] {
  const roots = [resolve(cwd)]
  let top: string | null = null
  try {
    top = findGitRoot(cwd)
  } catch {
    top = null
  }
  if (top !== null && resolve(top) !== roots[0]) roots.push(resolve(top))
  return roots
}

function normalizeEventPath(eventPath: string): string {
  return resolve(sep === '\\' ? eventPath.replace(/\//g, '\\') : eventPath)
}

function sourceForPath(filePath: string): SettingSource | null {
  const normalized = normalizeEventPath(filePath)
  const known = knownSettingsFiles.get(normalized)
  if (known !== undefined) return known
  if (dropInDir !== null && normalized.startsWith(dropInDir + sep) && normalized.endsWith('.json')) {
    return 'policySettings'
  }
  return null
}

function fanOut(source: SettingSource): void {
  resetSettingsCache()
  changeSignal.emit(source)
}

function handleChange(filePath: string): void {
  const normalized = normalizeEventPath(filePath)
  const source = sourceForPath(normalized)
  if (source === null) return
  const pending = pendingDeletions.get(normalized)
  if (pending !== undefined) {
    stopTimeout(pending)
    pendingDeletions.delete(normalized)
  }
  if (consumeInternalWrite(normalized, internalWriteWindowMs)) return
  fanOut(source)
}

function handleUnlink(filePath: string): void {
  const normalized = normalizeEventPath(filePath)
  const source = sourceForPath(normalized)
  if (source === null) return
  if (pendingDeletions.has(normalized)) return
  const timer = startTimeout(() => {
    pendingDeletions.delete(normalized)
    fanOut(source)
  }, stabilityThresholdMs + pollIntervalMs + 250)
  timer.unref?.()
  pendingDeletions.set(normalized, timer)
}

function startMdmPoll(): void {
  mdmSnapshot = JSON.stringify({ mdm: getMdmSettings(), hkcu: getHkcuSettings() })
  mdmPollTimer = startInterval(() => {
    if (disposed) return
    void refreshMdmSettings().then(
      result => {
        const next = JSON.stringify(result)
        if (next !== mdmSnapshot) {
          mdmSnapshot = next
          setMdmSettingsCache(result.mdm, result.hkcu)
          fanOut('policySettings')
        }
      },
      (error: unknown) => {
        logForDebugging(`MDM poll failed: ${String(error)}`)
      },
    )
  }, mdmPollIntervalMs)
  mdmPollTimer.unref?.()
}

async function initialize(): Promise<void> {
  if (getIsRemoteMode() || initialized || disposed) return
  initialized = true
  startMdmPoll()
  if (!cleanupRegistered) {
    cleanupRegistered = true
    registerCleanup(async () => {
      await dispose()
    })
  }

  const nextKnown = new Map<string, SettingSource>()
  const nextRoots = new Set<string>()
  const nextAwaited = new Set<string>()

  const addTarget = (filePath: string, source: SettingSource): void => {
    const normalized = normalizeEventPath(filePath)
    nextKnown.set(normalized, source)
    try {
      const parent = dirname(normalized)
      if (existsSync(parent)) {
        nextRoots.add(normalizeEventPath(parent))
      } else if (PROJECT_SOURCES.has(source)) {
        const projectRoot = dirname(parent)
        if (existsSync(projectRoot)) {
          nextRoots.add(normalizeEventPath(projectRoot))
          nextAwaited.add(normalizeEventPath(parent))
        }
      }
    } catch (error) {
      passedOver(error)
    }
  }

  for (const root of projectWatchRoots(getCwd())) {
    for (const configDir of projectConfigDirs(root)) {
      addTarget(join(configDir, 'mcp.json'), 'projectSettings')
    }
  }

  for (const source of SETTING_SOURCES) {
    if (source === 'flagSettings') continue
    const filePath = getSettingsFilePathForSource(source)
    if (!filePath) continue
    addTarget(filePath, source)
  }

  try {
    const candidateDropIn = getManagedSettingsDropInDir()
    if (existsSync(candidateDropIn)) {
      const resolvedDropIn = normalizeEventPath(candidateDropIn)
      dropInDir = resolvedDropIn
      nextRoots.add(resolvedDropIn)
    }
  } catch (error) {
    passedOver(error)
    dropInDir = null
  }

  knownSettingsFiles = nextKnown
  awaitedParents = nextAwaited
  watchedRoots = nextRoots

  if (watchedRoots.size === 0) return

  const ignored = ignoringSpecialFiles((candidatePath: string) => {
    const normalized = normalizeEventPath(candidatePath)
    if (normalized.split(sep).includes('.git')) return true
    if (watchedRoots.has(normalized)) return false
    if (awaitedParents.has(normalized)) return false
    if (dropInDir !== null && normalized === dropInDir) return false
    if (knownSettingsFiles.has(normalized)) return false
    if (dropInDir !== null && normalized.startsWith(dropInDir + sep) && normalized.endsWith('.json')) return false
    return true
  })

  watcher = chokidar.watch([...watchedRoots].map(resolveWatchRoot), {
    persistent: true,
    ignoreInitial: true,
    depth: 1,
    ignorePermissionErrors: true,
    atomic: true,
    awaitWriteFinish: {
      stabilityThreshold: stabilityThresholdMs,
      pollInterval: pollIntervalMs,
    },
    ...(typeof Bun !== 'undefined' ? { usePolling: true, interval: bunPollIntervalMs } : {}),
    ignored,
  })

  watcher.on('change', handleChange)
  watcher.on('add', handleChange)
  watcher.on('unlink', handleUnlink)
  watcher.on('addDir', (dirPath: string) => {
    const normalized = normalizeEventPath(dirPath)
    if (!awaitedParents.has(normalized)) return
    awaitedParents.delete(normalized)
    watchedRoots.add(normalized)
    watcher?.add(resolveWatchRoot(normalized))
    const existingTargets: string[] = []
    for (const target of knownSettingsFiles.keys()) {
      if (dirname(target) === normalized && existsSync(target)) {
        existingTargets.push(target)
      }
    }
    if (existingTargets.length > 0) {
      const timer = startTimeout(() => {
        for (const target of existingTargets) handleChange(target)
      }, stabilityThresholdMs + pollIntervalMs)
      timer.unref?.()
    }
  })
  watcher.on('error', logError)
}

function subscribe(listener: (source: SettingSource) => void): () => void {
  return changeSignal.subscribe(listener)
}

function notifyChange(source: SettingSource): void {
  fanOut(source)
}

async function dispose(): Promise<void> {
  disposed = true
  if (mdmPollTimer !== null) {
    stopInterval(mdmPollTimer)
    mdmPollTimer = null
  }
  for (const timer of pendingDeletions.values()) stopTimeout(timer)
  pendingDeletions.clear()
  mdmSnapshot = null
  clearInternalWrites()
  changeSignal.clear()
  const closing = watcher?.close()
  watcher = null
  if (closing !== undefined) await closing
}

async function resetForTesting(overrides?: TimingOverrides): Promise<void> {
  if (mdmPollTimer !== null) {
    stopInterval(mdmPollTimer)
    mdmPollTimer = null
  }
  for (const timer of pendingDeletions.values()) stopTimeout(timer)
  pendingDeletions.clear()
  mdmSnapshot = null
  initialized = false
  disposed = false
  if (overrides !== undefined) {
    if (overrides.stabilityThresholdMs !== undefined) stabilityThresholdMs = overrides.stabilityThresholdMs
    if (overrides.pollIntervalMs !== undefined) pollIntervalMs = overrides.pollIntervalMs
    if (overrides.internalWriteWindowMs !== undefined) internalWriteWindowMs = overrides.internalWriteWindowMs
    if (overrides.mdmPollIntervalMs !== undefined) mdmPollIntervalMs = overrides.mdmPollIntervalMs
    if (overrides.bunPollIntervalMs !== undefined) bunPollIntervalMs = overrides.bunPollIntervalMs
  }
  const closing = watcher?.close()
  watcher = null
  if (closing !== undefined) await closing
}

async function reground(): Promise<void> {
  if (!initialized || disposed) return
  if (mdmPollTimer !== null) {
    stopInterval(mdmPollTimer)
    mdmPollTimer = null
  }
  for (const timer of pendingDeletions.values()) stopTimeout(timer)
  pendingDeletions.clear()
  mdmSnapshot = null
  const closing = watcher?.close() ?? Promise.resolve()
  watcher = null
  initialized = false
  await closing
  await initialize()
}

export function _watchTargetsForTesting(): string[] {
  return [...knownSettingsFiles.keys()]
}

export function _watchRootsForTesting(): { roots: string[]; awaited: string[] } {
  return { roots: [...watchedRoots].sort(), awaited: [...awaitedParents].sort() }
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
