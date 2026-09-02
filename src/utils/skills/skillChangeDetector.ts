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

/**
 * Watches skill and command directories and debounces reloads. Watching
 * covers every project-config home (the loader merges all homes, so a
 * skill loading from one home must hot-reload too) and every --add-dir
 * skills directory.
 */

type TimingOverrides = {
  stabilityThresholdMs?: number
  pollIntervalMs?: number
  debounceMs?: number
  bunPollIntervalMs?: number
  /** Injectable watcher factory (the timing-seam precedent) — provers
   *  drive the re-arm race without a real chokidar watcher. */
  watcherFactory?: WatcherFactory
}

/** The structural slice of chokidar.FSWatcher this module drives. */
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
// Coarse on purpose: skill files change rarely, and Bun's native watcher
// can deadlock when a watcher closes while its thread delivers events
// (chokidar at depth 2 on large skill trees during git operations).
let bunPollIntervalMs = 2000

let initialized = false
let disposed = false
let watcherFactory: WatcherFactory = defaultWatcherFactory
/** Bumped by every re-arm/dispose: an arm that finds a NEWER generation
 *  lost an overlap race and closes what it built instead of assigning —
 *  two overlapping re-arms can never orphan a live watcher. */
let watcherGeneration = 0
let watcher: SkillWatcher | null = null
/** The BIRTH watcher: nearest existing ancestors of candidates that do not
 *  exist yet — a skills directory's creation is itself an event
 *  (release-hardening audit rank 28). Lifecycled exactly like `watcher`. */
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
        // ONE hook execution for the whole batch, with one representative
        // path — per-path firing would spam identical queries.
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
  // Once, never repeated or undone: dynamic skills clear only the
  // command MEMOISATION caches — the full command cache would clear the
  // skill caches and wipe the dynamic skills just loaded.
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

/**
 * RE-ARM ON THE CURRENT GROUND (the ground-move half): the
 * watch roots are derived from process.cwd() and FROZEN when the watcher is
 * built — after a projects-picker ground move the old watcher keeps
 * watching the OLD repo's skill dirs, so a skill created in the newly
 * picked repo never fires the change signal. This door closes the old
 * watcher and arms a new one over the CURRENT ground's paths, KEEPING the
 * signal's subscribers and the dynamic-skills registration (unlike the
 * proof-only reset). Idempotent and cheap when the ground did not move.
 * Returns the roots it armed (the proof reads them).
 */
async function rearmWatchRoots(): Promise<string[]> {
  if (disposed) return []
  initialized = true
  registerDynamicSkillsOnce()
  const gen = ++watcherGeneration
  const closing = Promise.all([watcher?.close() ?? Promise.resolve(), birthWatcher?.close() ?? Promise.resolve()])
  watcher = null
  birthWatcher = null
  await closing
  // A newer re-arm entered while the close settled — it owns the ground.
  if (gen !== watcherGeneration || disposed) return []
  return armWatcher(gen)
}

/** Nearest EXISTING ancestor worth watching for a candidate's birth —
 *  bounded: never the user's home itself and never a filesystem root
 *  (watching those costs, and on macOS can prompt, far beyond a skills
 *  directory's birth). Null when no watchable ancestor exists. */
function nearestWatchableAncestor(path: string): string | null {
  const home = homedir()
  let cur = resolve(path)
  for (;;) {
    const parent = dirname(cur)
    if (parent === cur) return null // filesystem root
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
  // A candidate that does not exist yet is watched at its nearest existing
  // ancestor: the directory's OWN creation is the event. The old
  // existsSync gate froze the watch set at boot — the first skill created
  // mid-session never applied ("Unknown skill" until a restart), and with
  // every candidate absent no watcher was armed at all
  // (release-hardening audit rank 28).
  const birthAncestors = new Map<string, Set<string>>()
  const addCandidate = (path: string): void => {
    try {
      if (existsSync(path)) {
        targets.add(path)
        return
      }
    } catch {
      return // Skip unprobeable paths.
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
  for (const path of getProjectSkillsWatchPaths('commands')) addCandidate(path)
  for (const additionalDir of getAddedDirectories()) {
    for (const path of getProjectSkillsWatchPaths('skills', additionalDir)) addCandidate(path)
  }

  if (targets.size === 0 && birthAncestors.size === 0) return []
  if (disposed || gen !== watcherGeneration) return []

  const runningUnderBun = typeof Bun !== 'undefined'

  // The birth watcher: ancestors at depth 1, addDir/add events filtered to
  // the missing chains. On a birth: reload (the creating burst usually
  // carries the SKILL.md, landing before any re-armed watcher could see
  // it) and re-arm onto the newly existing ground.
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
    // Only birth targets this generation; the re-arm brings the real
    // watcher once a candidate exists. The disposal registration still
    // applies — the birth watcher is a real handle.
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
    // Skills are skill-name/SKILL.md.
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
    // Lost the race AFTER arming — close the orphan instead of assigning.
    void built.close()
    return []
  }
  watcher = built

  // Registered AFTER the watcher exists, and unregistered on disposal —
  // a dispose/re-initialise cycle must not accumulate handlers (and a
  // re-arm must not register a second one).
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
  watcherGeneration++ // an in-flight arm loses and closes what it built
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

/** Leaves the dynamic-skills registration in place. */
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
