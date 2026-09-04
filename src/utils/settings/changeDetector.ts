import { existsSync } from 'node:fs'
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
let knownSettingsFiles = new Map<string, SettingSource>()
let dropInDir: string | null = null
let watchedRoots = new Set<string>()
const changeSignal = createSignal<[SettingSource]>()

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

async function handleChange(eventPath: string): Promise<void> {
  const source = sourceForPath(eventPath)
  if (source === null) return
  const normalized = normalizeEventPath(eventPath)
  const pending = pendingDeletions.get(normalized)
  if (pending !== undefined) {
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
  if (pendingDeletions.has(normalized)) return
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
  for (const source of SETTING_SOURCES) {
    if (source === 'flagSettings') continue
    const filePath = getSettingsFilePathForSource(source)
    if (filePath === undefined) continue
    const normalized = resolve(filePath)
    files.set(normalized, source)
    const parent = dirname(normalized)
    try {
      if (existsSync(parent)) directories.add(parent)
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
    ignored: (candidatePath: string) => {
      const normalized = normalizeEventPath(candidatePath)
      if (normalized.split(sep).includes('.git')) return true
      if (watchedRoots.has(normalized)) return false
      if (dropInDir !== null && normalized === dropInDir) return false
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

export { initialize, dispose, subscribe, notifyChange, reground, resetForTesting }

export const settingsChangeDetector = {
  initialize,
  dispose,
  subscribe,
  notifyChange,
  reground,
  resetForTesting,
}
