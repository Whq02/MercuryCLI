import { existsSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import { getCwd } from '../cwd.js'
import { findGitRoot } from '../git.js'
import { projectConfigDirs } from '../projectConfig.js'

import * as chokidar from 'chokidar'

import { getIsRemoteMode } from '../../bootstrap/state.js'
import { registerCleanup } from '../cleanupRegistry.js'
import { logForDebugging } from '../debug.js'
import { logError } from '../log.js'
import { createSignal } from '../signal.js'
import { ignoringSpecialFiles, resolveWatchRoot } from '../watchRoot.js'
import type { SettingSource } from './constants.js'
import { SETTING_SOURCES } from './constants.js'
import { clearInternalWrites, consumeInternalWrite } from './internalWrites.js'
import { getManagedSettingsDropInDir } from './managedPath.js'
import { refreshMdmSettings, getHkcuSettings, getMdmSettings, setMdmSettingsCache } from './mdm/settings.js'
import { getSettingsFilePathForSource } from './settings.js'
import { resetSettingsCache } from './settingsCache.js'


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

let initialized = false
let disposed = false
let watcher: chokidar.FSWatcher | null = null
let cleanupRegistered = false
let mdmPollTimer: NodeJS.Timeout | null = null
let mdmSnapshot: string | null = null
const pendingDeletions = new Map<string, NodeJS.Timeout>()
let knownSettingsFiles = new Map<string, SettingSource>()
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

function sourceForPath(eventPath: string): SettingSource | null {
  const normalized = normalizeEventPath(eventPath)
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

function handleChange(eventPath: string): void {
  const source = sourceForPath(eventPath)
  if (source === null) return
  const normalized = normalizeEventPath(eventPath)
  const pending = pendingDeletions.get(normalized)
  if (pending !== undefined) {
    clearTimeout(pending)
    pendingDeletions.delete(normalized)
  }
  if (consumeInternalWrite(normalized, internalWriteWindowMs)) return
  fanOut(source)
}

function handleUnlink(eventPath: string): void {
  const source = sourceForPath(eventPath)
  if (source === null) return
  const normalized = normalizeEventPath(eventPath)
  if (pendingDeletions.has(normalized)) return
  const graceMs = stabilityThresholdMs + pollIntervalMs + 250
  const timer = setTimeout(() => {
    pendingDeletions.delete(normalized)
    fanOut(source)
  }, graceMs)
  timer.unref?.()
  pendingDeletions.set(normalized, timer)
}

function startMdmPolling(): void {
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
  mdmPollTimer.unref?.()
}

async function initialize(): Promise<void> {
  if (getIsRemoteMode()) return
  if (initialized || disposed) return
  initialized = true
  startMdmPolling()
  if (!cleanupRegistered) {
    cleanupRegistered = true
    registerCleanup(async () => {
      await dispose()
    })
  }

  const files = new Map<string, SettingSource>()
  const directories = new Set<string>()
  const awaited = new Set<string>()
  const targets: Array<[string, SettingSource]> = []
  for (const dir of projectWatchRoots(getCwd())) {
    for (const root of projectConfigDirs(dir)) targets.push([join(root, 'mcp.json'), 'projectSettings'])
  }
  for (const source of SETTING_SOURCES) {
    if (source === 'flagSettings') continue
    const filePath = getSettingsFilePathForSource(source)
    if (filePath === undefined) continue
    targets.push([filePath, source])
  }
  for (const [filePath, source] of targets) {
    const normalized = resolve(filePath)
    files.set(normalized, source)
    const parent = dirname(normalized)
    try {
      if (existsSync(parent)) directories.add(parent)
      else if (PROJECT_SOURCES.has(source)) {
        const projectRoot = dirname(parent)
        if (existsSync(projectRoot)) {
          awaited.add(normalizeEventPath(parent))
          directories.add(projectRoot)
        }
      }
    } catch {
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
  awaitedParents = awaited
  watchedRoots = new Set([...directories].map(d => normalizeEventPath(resolve(d))))

  if (disposed) return
  if (directories.size === 0) return

  watcher = chokidar.watch([...directories].map(resolveWatchRoot), {
    persistent: true,
    ignoreInitial: true,
    depth: 1,
    awaitWriteFinish: { stabilityThreshold: stabilityThresholdMs, pollInterval: pollIntervalMs },
    ignorePermissionErrors: true,
    atomic: true,
    ...(typeof Bun !== 'undefined' ? { usePolling: true, interval: bunPollIntervalMs } : {}),
    ignored: ignoringSpecialFiles((candidatePath: string) => {
      const normalized = normalizeEventPath(candidatePath)
      if (normalized.split(sep).includes('.git')) return true
      if (watchedRoots.has(normalized)) return false
      if (awaitedParents.has(normalized)) return false
      if (dropInDir !== null && normalized === dropInDir) return false
      if (knownSettingsFiles.has(normalized)) return false
      if (dropInDir !== null && normalized.startsWith(dropInDir + sep) && normalized.endsWith('.json')) {
        return false
      }
      return true
    }),
  })
  watcher.on('change', path => handleChange(path))
  watcher.on('add', path => handleChange(path))
  watcher.on('addDir', path => {
    const normalized = normalizeEventPath(path)
    if (!awaitedParents.has(normalized)) return
    awaitedParents.delete(normalized)
    watchedRoots.add(normalized)
    watcher?.add(resolveWatchRoot(normalized))
    const arrivedWith = [...knownSettingsFiles.keys()].filter(file => dirname(file) === normalized && existsSync(file))
    if (arrivedWith.length === 0) return
    const settleMs = stabilityThresholdMs + pollIntervalMs
    const timer = setTimeout(() => {
      for (const file of arrivedWith) handleChange(file)
    }, settleMs)
    timer.unref?.()
  })
  watcher.on('unlink', path => handleUnlink(path))
  watcher.on('error', error => {
    logError(error)
  })
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
  if (overrides?.bunPollIntervalMs !== undefined) bunPollIntervalMs = overrides.bunPollIntervalMs
  const closing = watcher?.close() ?? Promise.resolve()
  watcher = null
  await closing
}

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
