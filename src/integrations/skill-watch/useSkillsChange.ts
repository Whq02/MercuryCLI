import { useRef } from 'react'
import { useClaim } from '../../screen/effects/effects.js'
import { watch, type FSWatcher } from 'node:fs'
import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { resolveWatchRoot, watchDirectory } from '../../platform/processes/watchRoot.js'
import {
  clearCommandsCache,
  getCommands,
  type Command,
} from '../../commands/catalogue/commands.js'
import { projectConfigCandidatePaths } from '../../platform/settings/projectConfig.js'
import { logForDebugging } from '../../platform/logs/debugLog.js'
import { useSetAppStateMaybe } from '../../screen/app-state/AppState.js'
import { getSessionId } from '../../boot/process-state/processState.js'
import { liveSkillRootsOf, pruneSkillSessionHooks } from '../event-hooks/sessionHooks.js'

function closestExistingAncestor(target: string): string | null {
  let current = dirname(resolve(target))
  while (!existsSync(current)) {
    const parent = dirname(current)
    if (parent === current) return null
    current = parent
  }
  return current
}

export function useSkillsChange(
  cwd: string | undefined,
  onCommandsChange: (commands: Command[]) => void,
): void {
  const onCommandsChangeRef = useRef(onCommandsChange)
  onCommandsChangeRef.current = onCommandsChange
  const setAppState = useSetAppStateMaybe()
  const setAppStateRef = useRef(setAppState)
  setAppStateRef.current = setAppState

  useClaim(() => {
    if (!cwd) return
    let cancelled = false
    const watchers = new Set<FSWatcher>()

    const rescan = (): void => {
      try {
        clearCommandsCache()
        void getCommands(cwd)
          .then(commands => {
            if (cancelled) return
            const setter = setAppStateRef.current
            if (setter) {
              pruneSkillSessionHooks(setter, getSessionId(), liveSkillRootsOf(commands))
            }
            onCommandsChangeRef.current(commands)
          })
          .catch(error => {
            logForDebugging(`skills rescan failed: ${error}`)
          })
      } catch (error) {
        logForDebugging(`skills cache clear failed: ${error}`)
      }
    }

    const armWatch = (dir: string): void => {
      if (cancelled) return
      const resolved = resolveWatchRoot(dir)
      try {
        if (existsSync(resolved)) {
          const watcher = watchDirectory(
            resolved,
            { recursive: true, persistent: false },
            () => {
              if (cancelled) return
              if (!existsSync(resolved)) {
                watchers.delete(watcher)
                watcher.close()
                rescan()
                armWatch(dir)
                return
              }
              rescan()
            },
            () => {
              watchers.delete(watcher)
              if (cancelled) return
              rescan()
              armWatch(dir)
            },
          )
          watcher.on('error', error => {
            logForDebugging(`skills watcher error: ${error}`)
          })
          watchers.add(watcher)
        } else {
          const ancestor = closestExistingAncestor(resolved)
          if (!ancestor) return
          const watcher = watch(resolveWatchRoot(ancestor), { persistent: false }, () => {
            if (cancelled) return
            watchers.delete(watcher)
            watcher.close()
            if (existsSync(resolved)) rescan()
            armWatch(dir)
          })
          watcher.on('error', error => {
            logForDebugging(`skills watcher error: ${error}`)
          })
          watchers.add(watcher)
        }
      } catch (error) {
        logForDebugging(`skills watcher failed for ${dir}: ${error}`)
      }
    }

    for (const dir of projectConfigCandidatePaths(cwd, 'skills')) {
      armWatch(dir)
    }

    return () => {
      cancelled = true
      for (const watcher of watchers) {
        watcher.close()
      }
      watchers.clear()
    }
  }, [cwd])
}
