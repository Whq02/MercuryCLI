import { basename, isAbsolute, resolve } from 'node:path'

import * as chokidar from 'chokidar'

import { registerCleanup } from '../cleanupRegistry.js'
import { logForDebugging } from '../debug.js'
import { clearCwdEnvFiles } from '../sessionEnvironment.js'
import { resolveWatchRoot } from '../watchRoot.js'
import { executeCwdChangedHooks, executeFileChangedHooks } from '../hooks.js'
import { getHooksConfigFromSnapshot } from './hooksConfigSnapshot.js'


let initialized = false
let currentCwd = ''
let watcher: chokidar.FSWatcher | null = null
let watchedPaths = new Set<string>()
let dynamicWatchPaths: string[] = []
let dynamicWatchPathsSorted: string[] = []
let notifier: ((text: string, isError: boolean) => void) | null = null

export function setEnvHookNotifier(callback: ((text: string, isError: boolean) => void) | null): void {
  notifier = callback
}

function notify(text: string, isError: boolean): void {
  notifier?.(text, isError)
}

function hasCwdOrFileHooks(): boolean {
  const snapshot = getHooksConfigFromSnapshot()
  return Boolean(snapshot?.CwdChanged?.length) || Boolean(snapshot?.FileChanged?.length)
}

function resolveWatchPaths(): string[] {
  const paths = new Set<string>()
  const matchers = getHooksConfigFromSnapshot()?.FileChanged ?? []
  for (const matcher of matchers) {
    for (const name of (matcher.matcher ?? '').split('|')) {
      const trimmed = name.trim()
      if (!trimmed) continue
      paths.add(isAbsolute(trimmed) ? trimmed : resolve(currentCwd, trimmed))
    }
  }
  for (const dynamicPath of dynamicWatchPaths) paths.add(dynamicPath)
  return [...paths]
}

function surfaceHookResults(results: Awaited<ReturnType<typeof executeFileChangedHooks>>): void {
  for (const systemMessage of results.systemMessages) notify(systemMessage, false)
  for (const result of results.results) {
    if (!result.succeeded && result.output) notify(result.output, true)
  }
}

function handleWatchEvent(event: 'change' | 'add' | 'unlink', path: string): void {
  const known =
    watchedPaths.has(path) || [...watchedPaths].some(watched => basename(watched) === basename(path))
  if (!known) return
  void executeFileChangedHooks(path, event)
    .then(results => {
      if (results.watchPaths.length > 0) updateWatchPaths(results.watchPaths)
      surfaceHookResults(results)
    })
    .catch(error => {
      logForDebugging(`file-changed hook run failed: ${error instanceof Error ? error.message : String(error)}`, {
        level: 'error',
      })
      notify(error instanceof Error ? error.message : String(error), true)
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
  logForDebugging(`file-changed watcher: ${resolved.length} matcher paths, ${armTargets.length} arm targets`)
  if (resolved.length === 0) return

  watcher = chokidar.watch(armTargets, {
    depth: 0,
    persistent: true,
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 500, pollInterval: 200 },
    ignorePermissionErrors: true,
  })
  watcher.on('error', error =>
    logForDebugging(`file-changed watcher error: ${error instanceof Error ? error.message : String(error)}`, {
      level: 'error',
    }),
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
  if (!hasCwdOrFileHooks()) return
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

export async function onCwdChangedForHooks(oldCwd: string, newCwd: string): Promise<void> {
  if (oldCwd === newCwd) return
  if (!hasCwdOrFileHooks()) return
  currentCwd = newCwd
  await clearCwdEnvFiles()
  let results: Awaited<ReturnType<typeof executeCwdChangedHooks>>
  try {
    results = await executeCwdChangedHooks(oldCwd, newCwd)
  } catch (error) {
    logForDebugging(`cwd-changed hook run failed: ${error instanceof Error ? error.message : String(error)}`, {
      level: 'error',
    })
    notify(error instanceof Error ? error.message : String(error), true)
    results = { results: [], watchPaths: [], systemMessages: [] }
  }
  dynamicWatchPaths = [...results.watchPaths]
  dynamicWatchPathsSorted = [...results.watchPaths].sort()
  surfaceHookResults(results)
  if (initialized) {
    await restartWatching()
  }
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
  notifier = null
}

export function resetFileChangedWatcherForTesting(): void {
  void disposeFileChangedWatcher()
}
