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
const changeSignal = createSignal()
let unregisterCleanup: (() => void) | null = null

function scheduleReload(path: string): void {
  pendingPaths.add(path)
  if (reloadTimer !== null) return
  reloadTimer = startTimeout(() => {
    reloadTimer = null
    pendingPaths = new Set()
    clearSkillCaches()
    clearCommandsCache()
    resetSentSkillNames()
    changeSignal.emit()
  }, debounceMs)
  reloadTimer.unref?.()
}

function registerDynamicSkills(): void {
  if (dynamicSkillsRegistered) return
  dynamicSkillsRegistered = true
  onDynamicSkillsLoaded(() => {
    clearCommandMemoizationCaches()
    changeSignal.emit()
  })
}

function closeWatchers(): Promise<void[]> {
  const closing = Promise.all([watcher?.close(), birthWatcher?.close()])
  watcher = null
  birthWatcher = null
  return closing
}

function armWatchers(generation: number): string[] {
  const roots = [getSkillsPath('userSettings', 'skills'), ...getProjectSkillsWatchPaths('skills')]
  const targets: string[] = []
  const ancestors = new Set<string>()
  const missing: string[] = []
  for (const root of roots) {
    try {
      if (existsSync(root)) targets.push(root)
      else {
        const ancestor = nearestWatchableAncestor(root)
        if (ancestor !== null) {
          ancestors.add(ancestor)
          missing.push(resolveWatchRoot(resolve(root)))
        }
      }
    } catch (error) {
      passedOver(error)
    }
  }
  const stale = () => disposed || generation !== watcherGeneration
  if ((!targets.length && !ancestors.size) || stale()) return []
  const polling = typeof Bun === 'undefined' ? {} : { usePolling: true, interval: bunPollIntervalMs }
  if (ancestors.size) {
    const onChain = (path: string) => {
      const candidate = resolve(path)
      return missing.some(root => candidate === root || root.startsWith(candidate + sep) || candidate.startsWith(root + sep))
    }
    const birth = watcherFactory([...ancestors].map(resolveWatchRoot), {
      persistent: true, ignoreInitial: true, depth: 1, ignorePermissionErrors: true, atomic: true,
      ...polling, ignored: ignoringSpecialFiles(path => !onChain(path)),
    })
    const added = (path: string) => {
      if (onChain(path)) {
        scheduleReload(resolve(path))
        void rearmWatchRoots()
      }
    }
    birth.on('addDir', added)
    birth.on('add', added)
    birth.on('error', error => logForDebugging(`skill birth watcher error: ${String(error)}`))
    if (stale()) {
      void birth.close()
      return []
    }
    birthWatcher = birth
  }
  if (targets.length) {
    const target = watcherFactory(targets.map(resolveWatchRoot), {
      persistent: true, ignoreInitial: true, depth: SKILL_WALK_MAX_DEPTH,
      awaitWriteFinish: { stabilityThreshold: stabilityThresholdMs, pollInterval: pollIntervalMs },
      ignorePermissionErrors: true, atomic: true, ...polling,
      ignored: ignoringSpecialFiles(path => {
        if (resolve(path).split(sep).includes('.git')) return true
        try {
          const info = statSync(path)
          return info.isSocket() || info.isFIFO() || info.isCharacterDevice() || info.isBlockDevice()
        } catch (error) {
          passedOver(error)
          return false
        }
      }),
    })
    target.on('add', scheduleReload)
    target.on('change', scheduleReload)
    target.on('unlink', scheduleReload)
    target.on('error', logError)
    if (stale()) {
      void target.close()
      return []
    }
    watcher = target
  }
  unregisterCleanup ??= registerCleanup(dispose)
  return targets
}

async function initialize(): Promise<void> {
  if (initialized || disposed) return
  initialized = true
  registerDynamicSkills()
  armWatchers(++watcherGeneration)
}

async function rearmWatchRoots(): Promise<string[]> {
  if (disposed) return []
  initialized = true
  registerDynamicSkills()
  const generation = ++watcherGeneration
  await closeWatchers()
  if (generation !== watcherGeneration || disposed) return []
  return armWatchers(generation)
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
  disposed = true
  watcherGeneration++
  if (reloadTimer !== null) stopTimeout(reloadTimer)
  reloadTimer = null
  pendingPaths = new Set()
  changeSignal.clear()
  unregisterCleanup?.()
  unregisterCleanup = null
  await closeWatchers()
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

export const skillChangeDetector = { initialize, dispose, subscribe, rearmWatchRoots, resetForTesting }
