import { existsSync, watch, type FSWatcher } from 'node:fs'
import { basename, dirname, relative, resolve, sep } from 'node:path'
import { subscribeUiClock } from '../../screen/cockpit/uiClock.js'
import { passedOver } from '../../platform/errors/passedOver.js'
import { resolveWatchRoot } from '../../platform/processes/watchRoot.js'

const STORAGE_WATCH_FALLBACK_MS = 2500

type StorageFileWatch = {
  listeners: Set<() => void>
  stop: () => void
}

const storageFileWatchers = new Map<string, StorageFileWatch>()

function nearestExistingDir(dir: string): string {
  let current = dir
  while (current !== dirname(current) && !existsSync(current)) current = dirname(current)
  return current
}

function fanOutStorageFile(key: string): void {
  const entry = storageFileWatchers.get(key)
  if (!entry) return
  for (const listener of [...entry.listeners]) {
    try {
      listener()
    } catch (error) {
      passedOver(error)
    }
  }
}

export function notifyStorageFile(filePath: string): void {
  fanOutStorageFile(resolve(filePath))
}

export function subscribeStorageFile(filePath: string, listener: () => void): () => void {
  const key = resolve(filePath)
  let entry = storageFileWatchers.get(key)
  if (!entry) {
    const targetDir = dirname(key)
    const base = basename(key)
    const listeners = new Set<() => void>()
    let watcher: FSWatcher | null = null
    let watchedDir: string | null = null
    let stopFallback: (() => void) | null = null
    let disposed = false

    const closeWatcher = (): void => {
      if (watcher === null) return
      const active = watcher
      watcher = null
      watchedDir = null
      try {
        active.close()
      } catch (error) {
        passedOver(error)
      }
    }

    const armFallback = (): void => {
      if (disposed || stopFallback !== null) return
      stopFallback = subscribeUiClock(STORAGE_WATCH_FALLBACK_MS, () => fanOutStorageFile(key))
    }

    const armWatcher = (): void => {
      if (disposed) return
      const nextDir = nearestExistingDir(targetDir)
      if (watcher !== null && watchedDir === nextDir) return
      closeWatcher()
      const onTarget = nextDir === targetDir
      const nextChild = onTarget ? null : relative(nextDir, targetDir).split(sep)[0] ?? null
      try {
        const next = watch(resolveWatchRoot(nextDir), { persistent: false }, (_event, filename) => {
          if (disposed) return
          const name = filename === null ? null : String(filename)
          if (!onTarget) {
            if (name !== null && nextChild !== null && name !== nextChild) return
            const refreshed = nearestExistingDir(targetDir)
            if (refreshed !== nextDir) {
              armWatcher()
              fanOutStorageFile(key)
            }
            return
          }
          if (name === null || name === base || name.startsWith(`${base}.`)) {
            fanOutStorageFile(key)
          }
        })
        next.on('error', () => {
          if (watcher === next) closeWatcher()
          armFallback()
        })
        watcher = next
        watchedDir = nextDir
        if (!onTarget && nearestExistingDir(targetDir) !== nextDir) armWatcher()
      } catch (error) {
        passedOver(error)
        armFallback()
      }
    }

    entry = {
      listeners,
      stop: () => {
        disposed = true
        closeWatcher()
        if (stopFallback !== null) {
          stopFallback()
          stopFallback = null
        }
      },
    }
    storageFileWatchers.set(key, entry)
    armWatcher()
  }
  entry.listeners.add(listener)
  return () => {
    const current = storageFileWatchers.get(key)
    if (!current) return
    current.listeners.delete(listener)
    if (current.listeners.size === 0) {
      current.stop()
      storageFileWatchers.delete(key)
    }
  }
}

export function subscribeAgentMetadataPath(path: string, listener: () => void): () => void {
  return subscribeStorageFile(path, listener)
}
