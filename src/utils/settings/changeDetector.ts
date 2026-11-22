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
import { passedOver } from '../passedOver.js'
import { startInterval, startTimeout, stopInterval, stopTimeout } from '../timers.js'
import { notBuilt, unbuilt } from '../../pi/holes.js'


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

let initialized: boolean = unbuilt('src/utils/settings/changeDetector.ts:40')
let disposed: boolean = unbuilt('src/utils/settings/changeDetector.ts:41')
let watcher: chokidar.FSWatcher | null = unbuilt('src/utils/settings/changeDetector.ts:42')
let mdmPollTimer: NodeJS.Timeout | null = unbuilt('src/utils/settings/changeDetector.ts:44')
let mdmSnapshot: string | null = unbuilt('src/utils/settings/changeDetector.ts:45')
const pendingDeletions: Map<string, NodeJS.Timeout> = unbuilt('src/utils/settings/changeDetector.ts:46')
let knownSettingsFiles: Map<string, SettingSource> = unbuilt('src/utils/settings/changeDetector.ts:47')
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

function fanOut(source: SettingSource): void {
  return notBuilt('src/utils/settings/changeDetector.ts:80')
}

async function initialize(): Promise<void> {
  return notBuilt('src/utils/settings/changeDetector.ts:132')
}

function subscribe(listener: (source: SettingSource) => void): () => void {
  return changeSignal.subscribe(listener)
}

function notifyChange(source: SettingSource): void {
  fanOut(source)
}

async function dispose(): Promise<void> {
  return notBuilt('src/utils/settings/changeDetector.ts:241')
}

async function resetForTesting(overrides?: TimingOverrides): Promise<void> {
  return notBuilt('src/utils/settings/changeDetector.ts:257')
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
