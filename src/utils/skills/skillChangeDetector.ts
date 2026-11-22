import { existsSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, resolve, sep } from 'node:path'

import * as chokidar from 'chokidar'

import { clearCommandMemoizationCaches, clearCommandsCache } from '../../commands.js'
import { clearSkillCaches, getProjectSkillsWatchPaths, getSkillsPath, onDynamicSkillsLoaded, SKILL_WALK_MAX_DEPTH } from '../../skills/loadSkillsDir.js'
import { resetSentSkillNames } from '../attachments/skillListing.js'
import { registerCleanup } from '../cleanupRegistry.js'
import { logForDebugging } from '../debug.js'
import { logError } from '../log.js'
import { createSignal } from '../signal.js'
import { ignoringSpecialFiles, resolveWatchRoot } from '../watchRoot.js'
import { passedOver } from '../passedOver.js'
import { startTimeout, stopTimeout } from '../timers.js'
import { notBuilt, unbuilt, type Unbuilt } from '../../pi/holes.js'


type TimingOverrides = {
  stabilityThresholdMs?: number
  pollIntervalMs?: number
  debounceMs?: number
  bunPollIntervalMs?: number
  watcherFactory?: WatcherFactory
}

type SkillWatcher = {
  on(event: 'add' | 'addDir' | 'change' | 'unlink', cb: (path: string) => void): unknown
  on(event: 'error', cb: (error: unknown) => void): unknown
  close: () => Promise<void>
}
type WatcherFactory = (paths: string[], options: Parameters<typeof chokidar.watch>[1]) => SkillWatcher

const defaultWatcherFactory: WatcherFactory = (paths, options) =>
  chokidar.watch(paths, options)

let stabilityThresholdMs = 1000
let pollIntervalMs = 500
let debounceMs = 300
let bunPollIntervalMs = 2000

let initialized = false
let disposed = false
let watcherFactory: WatcherFactory = defaultWatcherFactory
let watcherGeneration = 0
let watcher: SkillWatcher | null = null
let birthWatcher: SkillWatcher | null = null
let reloadTimer: NodeJS.Timeout | null = null
let pendingPaths = new Set<string>()
let dynamicSkillsRegistered = false
const changeSignal: Unbuilt = unbuilt('src/utils/skills/skillChangeDetector.ts:52')

async function initialize(): Promise<void> {
  return notBuilt('src/utils/skills/skillChangeDetector.ts:77')
}

async function rearmWatchRoots(): Promise<string[]> {
  return notBuilt('src/utils/skills/skillChangeDetector.ts:84')
}

function nearestWatchableAncestor(path: string): string | null {
  const home = homedir()
  let cur = resolve(path)
  for (;;) {
    const parent = dirname(cur)
    if (parent === cur) return null
    try {
      if (existsSync(parent)) {
        if (parent === home || dirname(parent) === parent) return null
        return parent
      }
    } catch (error) {
      passedOver(error)
      return null
    }
    cur = parent
  }
}

function subscribe(listener: () => void): () => void {
  return changeSignal.subscribe(listener)
}

async function dispose(): Promise<void> {
  return notBuilt('src/utils/skills/skillChangeDetector.ts:232')
}

async function resetForTesting(overrides?: TimingOverrides): Promise<void> {
  if (reloadTimer !== null) {
    stopTimeout(reloadTimer)
    reloadTimer = null
  }
  pendingPaths = new Set()
  changeSignal.clear()
  initialized = false
  disposed = false
  watcherGeneration++
  watcherFactory = overrides?.watcherFactory ?? defaultWatcherFactory
  if (overrides?.stabilityThresholdMs !== undefined) stabilityThresholdMs = overrides.stabilityThresholdMs
  if (overrides?.pollIntervalMs !== undefined) pollIntervalMs = overrides.pollIntervalMs
  if (overrides?.debounceMs !== undefined) debounceMs = overrides.debounceMs
  if (overrides?.bunPollIntervalMs !== undefined) bunPollIntervalMs = overrides.bunPollIntervalMs
  const closing = Promise.all([watcher?.close() ?? Promise.resolve(), birthWatcher?.close() ?? Promise.resolve()])
  watcher = null
  birthWatcher = null
  await closing
}

export { initialize, dispose, subscribe, rearmWatchRoots, resetForTesting }

export const skillChangeDetector: Unbuilt = unbuilt('src/utils/skills/skillChangeDetector.ts:274')
