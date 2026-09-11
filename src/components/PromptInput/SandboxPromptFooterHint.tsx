
import React, { useEffect, useRef } from 'react'
import { useNotifications } from '../../context/notifications.js'
import { SandboxManager } from '../../utils/sandbox/sandbox-adapter.js'
import { useShortcutDisplay } from '../../keybindings/useShortcutDisplay.js'
import { plural } from '../../utils/stringUtils.js'

const HINT_MS = 5000

export function SandboxPromptFooterHint(): React.ReactNode {
  const lastTotalRef = useRef(0)
  const enabled = SandboxManager.isSandboxingEnabled()
  const toggleChord = useShortcutDisplay('app:toggleTranscript', 'Global', 'ctrl+o')
  const { addNotification } = useNotifications()
  const addRef = useRef(addNotification)
  addRef.current = addNotification

  useEffect(() => {
    if (!enabled) return
    const store = SandboxManager.getSandboxViolationStore()
    lastTotalRef.current = store.getTotalCount()
    return store.subscribe(() => {
      const total = store.getTotalCount()
      const delta = total - lastTotalRef.current
      if (delta <= 0) return
      lastTotalRef.current = total
      addRef.current({
        key: 'sandbox-blocked',
        text: `sandbox blocked ${delta} ${plural(delta, 'operation')} · ${toggleChord} for details · /sandbox to disable`,
        priority: 'immediate',
        timeoutMs: HINT_MS,
      })
    })
  }, [enabled, toggleChord])

  return null
}
