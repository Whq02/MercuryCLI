import { basename, isAbsolute, relative, resolve } from 'node:path'

import * as chokidar from 'chokidar'

import { getSessionId } from '../../bootstrap/state.js'
import { registerCleanup } from '../cleanupRegistry.js'
import { logForDebugging } from '../debug.js'
import { invalidateSessionEnvCache } from '../sessionEnvironment.js'
import { ignoringSpecialFiles, resolveWatchRoot } from '../watchRoot.js'
import { fireHooks } from './fire.js'
import { hooksFor } from './matching.js'

let initialized = false
let currentCwd = ''
let watcher: chokidar.FSWatcher | null = null
let watchedPaths = new Set<string>()
let dynamicWatchPaths: string[] = []
let dynamicWatchPathsSorted: string[] = []

function scope(): { sessionId: string } {
  return { sessionId: String(getSessionId()) }
}

function resolveWatchPaths(): string[] {
  const paths = new Set<string>()
  for (const hook of hooksFor('file.changed', scope())) {
    for (const name of hook.entry.watch ?? []) {
      const trimmed = name.trim()
      if (!trimmed) continue
      paths.add(isAbsolute(trimmed) ? trimmed : resolve(currentCwd, trimmed))
    }
  }
  for (const dynamicPath of dynamicWatchPaths) paths.add(dynamicPath)
  return [...paths]
}

const CHANGE_WORDS = { change: 'changed', add: 'added', unlink: 'removed' } as const

function handleWatchEvent(event: keyof typeof CHANGE_WORDS, path: string): void {
  const known = watchedPaths.has(path) || [...watchedPaths].some(watched => basename(watched) === basename(path))
  if (!known) return
  const shown = isAbsolute(path) && currentCwd !== '' ? relative(currentCwd, path) || path : path
  void fireHooks('file.changed', { path: shown, change: CHANGE_WORDS[event] }, { scope: scope() })
    .then(result => {
      if (result.outcomes.length > 0) invalidateSessionEnvCache()
      if (result.answer.watch !== undefined && result.answer.watch.length > 0) updateWatchPaths(result.answer.watch.map(entry => (isAbsolute(entry) ? entry : resolve(currentCwd, entry))))
    })
    .catch(error => {
      logForDebugging(`file.changed hooks failed: ${error instanceof Error ? error.message : String(error)}`, { level: 'error' })
    })
}

async function startWatching(): Promise<void> {
  const resolved = resolveWatchPaths()
  watchedPaths = new Set(resolved)
  const fs = await import('node:fs')
  const armTargets: string[] = []
  for (const path of resolved) {
    if (fs.existsSync(path)) {
      armTargets.push(resolveWatchRoot(path))
      continue
    }
    const parent = resolve(path, '..')
    if (fs.existsSync(parent)) armTargets.push(resolveWatchRoot(parent))
  }
  logForDebugging(`file.changed watcher: ${resolved.length} watched paths, ${armTargets.length} arm targets`)
  if (resolved.length === 0) return

  watcher = chokidar.watch(armTargets, {
    depth: 0,
    persistent: true,
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 500, pollInterval: 200 },
    ignorePermissionErrors: true,
    ignored: ignoringSpecialFiles(),
  })
  watcher.on('error', error =>
    logForDebugging(`file.changed watcher error: ${error instanceof Error ? error.message : String(error)}`, { level: 'error' }),
  )
  watcher.on('change', path => handleWatchEvent('change', path))
  watcher.on('add', path => handleWatchEvent('add', path))
  watcher.on('unlink', path => handleWatchEvent('unlink', path))
}

async function restartWatching(): Promise<void> {
  if (watcher) {
    await watcher.close()
    watcher = null
  }
  await startWatching()
}

export function initializeFileChangedWatcher(cwd: string): void {
  if (initialized) return
  initialized = true
  currentCwd = cwd
  if (hooksFor('file.changed', scope()).length === 0) return
  registerCleanup(() => disposeFileChangedWatcher())
  if (resolveWatchPaths().length > 0) {
    void startWatching()
  }
}

export function updateWatchPaths(paths: string[]): void {
  if (!initialized) return
  const sorted = [...paths].sort()
  if (sorted.length === dynamicWatchPathsSorted.length && sorted.every((p, i) => p === dynamicWatchPathsSorted[i])) {
    return
  }
  dynamicWatchPaths = [...paths]
  dynamicWatchPathsSorted = sorted
  void restartWatching()
}

async function disposeFileChangedWatcher(): Promise<void> {
  if (watcher) {
    await watcher.close()
    watcher = null
  }
  initialized = false
  currentCwd = ''
  watchedPaths = new Set()
  dynamicWatchPaths = []
  dynamicWatchPathsSorted = []
}
