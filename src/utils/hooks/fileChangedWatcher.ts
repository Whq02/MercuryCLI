import { basename, isAbsolute, relative, resolve } from 'node:path'

import * as chokidar from 'chokidar'

import { getSessionId } from '../../bootstrap/state.js'
import { registerCleanup } from '../cleanupRegistry.js'
import { logForDebugging } from '../debug.js'
import { invalidateSessionEnvCache } from '../sessionEnvironment.js'
import { ignoringSpecialFiles, resolveWatchRoot } from '../watchRoot.js'
import { bankHookOutcomes } from './background.js'
import { fireHooks } from './fire.js'
import { hooksFor } from './matching.js'
import { notBuilt, unbuilt } from '../../pi/holes.js'
let currentCwd: string = unbuilt('src/utils/hooks/fileChangedWatcher.ts:15')
let watcher: chokidar.FSWatcher | null = unbuilt('src/utils/hooks/fileChangedWatcher.ts:16')
let watchedPaths: Set<string> = unbuilt('src/utils/hooks/fileChangedWatcher.ts:17')
let dynamicWatchPaths: string[] = unbuilt('src/utils/hooks/fileChangedWatcher.ts:18')

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
      bankHookOutcomes(result.outcomes)
      if (result.answer.watch !== undefined && result.answer.watch.length > 0) updateWatchPaths(result.answer.watch.map(entry => (isAbsolute(entry) ? entry : resolve(currentCwd, entry))))
    })
    .catch(error => {
      logForDebugging(`file.changed hooks failed: ${error instanceof Error ? error.message : String(error)}`, { level: 'error' })
    })
}

async function startWatching(): Promise<void> {
  return notBuilt('src/utils/hooks/fileChangedWatcher.ts:55')
}

let restarting: Promise<void> = Promise.resolve()

function restartWatching(): Promise<void> {
  const step = async (): Promise<void> => {
    if (watcher) {
      await watcher.close()
      watcher = null
    }
    await startWatching()
  }
  restarting = restarting.then(step, step)
  return restarting
}

export function initializeFileChangedWatcher(cwd: string): void {
  return notBuilt('src/utils/hooks/fileChangedWatcher.ts:101')
}

export function updateWatchPaths(paths: string[]): void {
  return notBuilt('src/utils/hooks/fileChangedWatcher.ts:112')
}
