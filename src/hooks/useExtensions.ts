// The extensions core's REPL-mount publication: the roster and the one
// health owner's readout land in app state once at mount (the boot load
// already ran under setup; this awaits the same promise), and the two
// nudges fire — a warning when health finds a broken extension, a
// low-priority notice when the project proposes or carries extensions not
// yet decided. Nothing is refreshed on a timer; the board's `r` swaps.

import { useEffect, useRef } from 'react'
import { useNotifications } from '../context/notifications.js'
import { useSetAppState } from '../state/AppState.js'
import type { AppState } from '../state/AppState.js'
import { ensureExtensionsLoaded, onExtensionsPending } from '../extensions/boot.js'
import { trustStateOf } from '../extensions/roster.js'
import type { ActiveSet } from '../extensions/active.js'
import { logForDebugging } from '../utils/debug.js'

/** Project the active set onto the app-state slot (the ONE place it is written). */
export function extensionsStateFrom(set: ActiveSet, pending: boolean, lastReloadLine: string | null): AppState['extensions'] {
  const health: AppState['extensions']['health'] = {}
  for (const [id, value] of set.healthById) health[id] = value
  return { roster: set.roster.entries, health, pending, problems: set.roster.problems, lastReloadLine }
}

export function useExtensions({ enabled = true }: { enabled?: boolean } = {}): void {
  const setAppState = useSetAppState()
  const { addNotification } = useNotifications()
  const addNotificationRef = useRef(addNotification)
  addNotificationRef.current = addNotification
  const loadedRef = useRef(false)

  useEffect(() => {
    if (!enabled || loadedRef.current) return
    loadedRef.current = true
    void (async () => {
      try {
        const result = await ensureExtensionsLoaded()
        setAppState(prev => ({ ...prev, extensions: extensionsStateFrom(result.set, false, result.line) }))
        const broken = result.counts.broken
        if (broken > 0) {
          addNotificationRef.current({
            key: 'extensions-broken',
            text: `${broken} extension${broken === 1 ? ' is' : 's are'} broken — /extensions`,
            color: 'warning',
            priority: 'medium',
          })
        }
        const undecided = result.set.roster.entries.filter(e => trustStateOf(e) === 'found').length
        if (undecided > 0) {
          addNotificationRef.current({
            key: 'extensions-proposed',
            text: `this project proposes ${undecided} extension${undecided === 1 ? '' : 's'} — /extensions to review`,
            priority: 'low',
          })
        }
      } catch (error) {
        logForDebugging(`extensions: the boot load failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    })()
  }, [enabled, setAppState])

  useEffect(() => {
    if (!enabled) return
    return onExtensionsPending(pending => {
      setAppState(prev => (prev.extensions.pending === pending ? prev : { ...prev, extensions: { ...prev.extensions, pending } }))
    })
  }, [enabled, setAppState])
}
