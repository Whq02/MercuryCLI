
import { useRef } from 'react'
import { useClaim, useLoad } from '../effects/effects.js'
import { useNotifications } from '../notifications/notifications.js'
import { useSetAppState } from '../app-state/AppState.js'
import type { AppState } from '../app-state/AppState.js'
import { ensureExtensionsLoaded, onExtensionsPending } from '../../integrations/extensions/boot.js'
import { trustStateOf } from '../../integrations/extensions/roster.js'
import type { ActiveSet } from '../../integrations/extensions/active.js'
import { logForDebugging } from '../../platform/logs/debugLog.js'

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

  useLoad(() => {
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
        const detail = error instanceof Error ? error.message : String(error)
        logForDebugging(`extensions: the boot load failed: ${detail}`)
        setAppState(prev => (prev.extensions.pending ? { ...prev, extensions: { ...prev.extensions, pending: false } } : prev))
        addNotificationRef.current({
          key: 'extensions-load-failed',
          text: `Extensions could not be loaded (${detail}) — /extensions`,
          color: 'warning',
          priority: 'medium',
        })
      }
    })()
  }, [enabled, setAppState])

  useClaim(() => {
    if (!enabled) return
    return onExtensionsPending(pending => {
      setAppState(prev => (prev.extensions.pending === pending ? prev : { ...prev, extensions: { ...prev.extensions, pending } }))
    })
  }, [enabled, setAppState])
}
