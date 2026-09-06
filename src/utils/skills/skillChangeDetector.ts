import { existsSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, resolve, sep } from 'node:path'

import * as chokidar from 'chokidar'

import { getAddedDirectories } from '../../bootstrap/state.js'
import { clearCommandMemoizationCaches, clearCommandsCache } from '../../commands.js'
import { clearSkillCaches, getProjectSkillsWatchPaths, getSkillsPath, onDynamicSkillsLoaded } from '../../skills/loadSkillsDir.js'
import { resetSentSkillNames } from '../attachments/skillListing.js'
import { registerCleanup } from '../cleanupRegistry.js'
import { logForDebugging } from '../debug.js'
import { executeConfigChangeHooks, hasBlockingResult } from '../hooks.js'
import { logError } from '../log.js'
import { createSignal } from '../signal.js'
import { resolveWatchRoot } from '../watchRoot.js'


type TimingOverrides = {
  stabilityThresholdMs?: number
  pollIntervalMs?: number
  debounceMs?: number
  bunPollIntervalMs?: number
  watcherFactory?: WatcherFactory
}

type SkillWatcher = {
  on: (event: string, cb: (arg: never) => void) => unknown
  close: () => Promise<void>
}
type WatcherFactory = (paths: string[], options: Parameters<typeof chokidar.watch>[1]) => SkillWatcher

const defaultWatcherFactory: WatcherFactory = (paths, options) =>
  chokidar.watch(paths, options) as unknown as SkillWatcher

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
let unregisterCleanup: (() => void) | null = null
const changeSignal = createSignal<[]>()

function scheduleReload(changedPath: string): void {
  pendingPaths.add(changedPath)
  if (reloadTimer !== null) return
  reloadTimer = setTimeout(() => {
    reloadTimer = null
    const batch = [...pendingPaths]
    pendingPaths = new Set()
    void (async () => {
      try {
        const results = await executeConfigChangeHooks('skills' as never, batch[0])
        if (hasBlockingResult(results)) {
          logForDebugging(`skill reload blocked by a config-change hook (${batch.length} changed paths)`)
          return
        }
      } catch (error) {
        logForDebugging(`skill config-change hook failed: ${String(error)}`)
      }
      clearSkillCaches()
      clearCommandsCache()
      resetSentSkillNames()
      changeSignal.emit()
    })()
  }, debounceMs)
  reloadTimer.unref?.()
}

function registerDynamicSkillsOnce(): void {
  if (dynamicSkillsRegistered) return
  dynamicSkillsRegistered = true
  onDynamicSkillsLoaded(() => {
    clearCommandMemoizationCaches()
    changeSignal.emit()
  })
}

async function initialize(): Promise<void> {
  if (initialized || disposed) return
  initialized = true
  registerDynamicSkillsOnce()
  await armWatcher(++watcherGeneration)
}

async function rearmWatchRoots(): Promise<string[]> {
  if (disposed) return []
  initialized = true
  registerDynamicSkillsOnce()
  const gen = ++watcherGeneration
  const closing = Promise.all([watcher?.close() ?? Promise.resolve(), birthWatcher?.close() ?? Promise.resolve()])
  watcher = null
  birthWatcher = null
  await closing
  if (gen !== watcherGeneration || disposed) return []
  return armWatcher(gen)
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
    } catch {
      return null
    }
    cur = parent
  }
}

async function armWatcher(gen: number): Promise<string[]> {
  const targets = new Set<string>()
  const birthAncestors = new Map<string, Set<string>>()
  const addCandidate = (path: string): void => {
    try {
      if (existsSync(path)) {
        targets.add(path)
        return
      }
    } catch {
      return
    }
    const ancestor = nearestWatchableAncestor(path)
    if (ancestor !== null) {
      const missing = birthAncestors.get(ancestor) ?? new Set<string>()
      missing.add(resolve(path))
      birthAncestors.set(ancestor, missing)
    }
  }
  addCandidate(getSkillsPath('userSettings', 'skills'))
  addCandidate(getSkillsPath('userSettings', 'commands'))
  for (const path of getProjectSkillsWatchPaths('skills')) addCandidate(path)
  for (const additionalDir of getAddedDirectories()) {
    for (const path of getProjectSkillsWatchPaths('skills', additionalDir)) addCandidate(path)
  }

  if (targets.size === 0 && birthAncestors.size === 0) return []
  if (disposed || gen !== watcherGeneration) return []

  const runningUnderBun = typeof Bun !== 'undefined'

  if (birthAncestors.size > 0) {
    const allMissing = [...birthAncestors.values()].flatMap(set => [...set])
    const birthBuilt = watcherFactory([...birthAncestors.keys()].map(resolveWatchRoot), {
      persistent: true,
      ignoreInitial: true,
      depth: 1,
      ignorePermissionErrors: true,
      atomic: true,
      ...(runningUnderBun ? { usePolling: true, interval: bunPollIntervalMs } : {}),
    })
    const onBirth = (rawPath: string): void => {
      const added = resolve(rawPath)
      const onChain = allMissing.some(
        missing => missing === added || missing.startsWith(added + sep) || added.startsWith(missing + sep),
      )
      if (!onChain) return
      scheduleReload(added)
      void rearmWatchRoots()
    }
    birthBuilt.on('addDir', path => onBirth(path as string))
    birthBuilt.on('add', path => onBirth(path as string))
    birthBuilt.on('error', error => logForDebugging(`skill birth watcher error: ${String(error)}`))
    if (disposed || gen !== watcherGeneration) {
      void birthBuilt.close()
      return []
    }
    birthWatcher = birthBuilt
  }

  if (targets.size === 0) {
    if (unregisterCleanup === null) {
      unregisterCleanup = registerCleanup(async () => {
        await dispose()
      })
    }
    return []
  }

  const built = watcherFactory([...targets].map(resolveWatchRoot), {
    persistent: true,
    ignoreInitial: true,
    depth: 2,
    awaitWriteFinish: { stabilityThreshold: stabilityThresholdMs, pollInterval: pollIntervalMs },
    ignorePermissionErrors: true,
    atomic: true,
    ...(runningUnderBun ? { usePolling: true, interval: bunPollIntervalMs } : {}),
    ignored: (candidatePath: string) => {
      const normalized = resolve(candidatePath)
      if (normalized.split(sep).includes('.git')) return true
      try {
        const stats = statSync(normalized) as unknown as {
          isSocket?(): boolean
          isFIFO?(): boolean
          isCharacterDevice?(): boolean
          isBlockDevice?(): boolean
        }
        if (stats.isSocket?.() || stats.isFIFO?.() || stats.isCharacterDevice?.() || stats.isBlockDevice?.()) {
          return true
        }
      } catch {
        return false
      }
      return false
    },
  })
  built.on('add', path => scheduleReload(path as string))
  built.on('change', path => scheduleReload(path as string))
  built.on('unlink', path => scheduleReload(path as string))
  built.on('error', error => {
    logError(error as Error)
  })
  if (disposed || gen !== watcherGeneration) {
    void built.close()
    return []
  }
  watcher = built

  if (unregisterCleanup === null) {
    unregisterCleanup = registerCleanup(async () => {
      await dispose()
    })
  }
  return [...targets]
}

function subscribe(listener: () => void): () => void {
  return changeSignal.subscribe(listener)
}

async function dispose(): Promise<void> {
  disposed = true
  watcherGeneration++
  if (reloadTimer !== null) {
    clearTimeout(reloadTimer)
    reloadTimer = null
  }
  pendingPaths = new Set()
  changeSignal.clear()
  if (unregisterCleanup !== null) {
    unregisterCleanup()
    unregisterCleanup = null
  }
  const closing = Promise.all([watcher?.close() ?? Promise.resolve(), birthWatcher?.close() ?? Promise.resolve()])
  watcher = null
  birthWatcher = null
  await closing
}

async function resetForTesting(overrides?: TimingOverrides): Promise<void> {
  if (reloadTimer !== null) {
    clearTimeout(reloadTimer)
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

export const skillChangeDetector = {
  initialize,
  dispose,
  subscribe,
  rearmWatchRoots,
  resetForTesting,
}
