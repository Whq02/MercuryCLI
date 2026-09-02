// Keeps the command list fresh on two triggers: a skill-file change
// (full cache clear + disk re-scan — content changed) and a feature-gate
// initialisation/refresh (memoisation-only clear — only the enablement
// predicates may have changed; the memoised list was baked with defaults
// until the refresh re-filters it). No-op without a working directory;
// errors are non-fatal.

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
  // Read through a ref so the watcher set never re-arms on a setter identity.
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
            // A skill that left the table takes its frontmatter hooks with
            // it — the registration used to be for good.
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
        // The directory does not exist yet: its creation is the event
        // (release-hardening audit rank 28 — the old existsSync gate froze
        // the watch set, so a first skill created mid-session never
        // applied). Watch the nearest existing ancestor; on an event,
        // re-arm — either onto the real recursive watch (candidate born:
        // rescan too, the creating burst usually carries the SKILL.md) or
        // onto a now-nearer ancestor.
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
