
import { useEffect, useRef } from 'react'
import { watch, type FSWatcher } from 'node:fs'
import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { resolveWatchRoot } from '../utils/watchRoot.js'
import {
  clearCommandMemoizationCaches,
  clearCommandsCache,
  getCommands,
  type Command,
} from '../commands.js'
import { onFeatureGatesRefresh } from '../services/analytics/featureGates.js'
import { projectConfigCandidatePaths } from '../utils/projectConfig.js'
import { logForDebugging } from '../utils/debug.js'
import { useSetAppStateMaybe } from '../state/AppState.js'
import { getSessionId } from '../bootstrap/state.js'
import { liveSkillRootsOf, pruneSkillSessionHooks } from '../utils/hooks/sessionHooks.js'

export function useSkillsChange(
  cwd: string | undefined,
  onCommandsChange: (commands: Command[]) => void,
): void {
  const onChangeRef = useRef(onCommandsChange)
  onChangeRef.current = onCommandsChange
  const maybeSetAppState = useSetAppStateMaybe()
  const setAppStateRef = useRef(maybeSetAppState)
  setAppStateRef.current = maybeSetAppState

  useEffect(() => {
    if (!cwd) return

    let alive = true
    const rescan = (full: boolean): void => {
      try {
        if (full) clearCommandsCache()
        else clearCommandMemoizationCaches()
        void getCommands(cwd)
          .then(commands => {
            if (!alive) return
            const setAppState = setAppStateRef.current
            if (setAppState !== null) pruneSkillSessionHooks(setAppState, getSessionId(), liveSkillRootsOf(commands))
            onChangeRef.current(commands)
          })
          .catch(error => logForDebugging(`skills rescan failed: ${error}`))
      } catch (error) {
        logForDebugging(`skills cache clear failed: ${error}`)
      }
    }

    const watchers: FSWatcher[] = []
    const armFor = (dir: string): void => {
      try {
        if (existsSync(dir)) {
          const watcher = watch(resolveWatchRoot(dir), { recursive: true }, () => rescan(true))
          watcher.unref?.()
          watcher.on('error', error =>
            logForDebugging(`skills watcher error: ${error}`),
          )
          watchers.push(watcher)
          return
        }
        let ancestor = dirname(resolve(dir))
        while (!existsSync(ancestor)) {
          const parent = dirname(ancestor)
          if (parent === ancestor) return
          ancestor = parent
        }
        const birth = watch(ancestor, {}, () => {
          if (!alive) return
          birth.close()
          if (existsSync(dir)) rescan(true)
          armFor(dir)
        })
        birth.unref?.()
        birth.on('error', error =>
          logForDebugging(`skills watcher error: ${error}`),
        )
        watchers.push(birth)
      } catch (error) {
        logForDebugging(`skills watcher failed for ${dir}: ${error}`)
      }
    }
    for (const dir of projectConfigCandidatePaths(cwd, 'skills')) armFor(dir)

    const unsubscribeGates = onFeatureGatesRefresh(() => rescan(false))

    return () => {
      alive = false
      unsubscribeGates()
      for (const watcher of watchers) watcher.close()
    }
  }, [cwd])
}
