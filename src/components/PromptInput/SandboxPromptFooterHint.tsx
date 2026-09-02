// Transient sandbox footer hint: appears when the violation store's
// total count increases, states how many operations were blocked in that
// batch (the delta, not the running total), names the transcript-toggle
// shortcut for details and the /sandbox command to disable. Clears after
// 5 s, resets its timer per batch, unsubscribes on unmount. Subscribed once
// at mount and only while sandboxing is enabled.

import React, { useEffect, useRef, useState } from 'react'
import { Text } from '../../ink.js'
import { SandboxManager } from '../../utils/sandbox/sandbox-adapter.js'
import { useShortcutDisplay } from '../../keybindings/useShortcutDisplay.js'
import { plural } from '../../utils/stringUtils.js'

const HINT_MS = 5000

export function SandboxPromptFooterHint(): React.ReactNode {
  const [recentCount, setRecentCount] = useState(0)
  const lastTotalRef = useRef(0)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const enabled = SandboxManager.isSandboxingEnabled()
  const toggleChord = useShortcutDisplay('app:toggleTranscript', 'Global', 'ctrl+o')

  useEffect(() => {
    if (!enabled) return
    const store = SandboxManager.getSandboxViolationStore()
    lastTotalRef.current = store.getTotalCount()
    const unsubscribe = store.subscribe(() => {
      const total = store.getTotalCount()
      const delta = total - lastTotalRef.current
      if (delta <= 0) return
      lastTotalRef.current = total
      setRecentCount(delta)
      if (timerRef.current) clearTimeout(timerRef.current)
      timerRef.current = setTimeout(() => setRecentCount(0), HINT_MS)
    })
    return () => {
      unsubscribe()
      if (timerRef.current) clearTimeout(timerRef.current)
    }
  }, [enabled])

  if (!enabled || recentCount === 0) return null

  return (
    <Text dimColor>
      sandbox blocked {recentCount} {plural(recentCount, 'operation')} ·{' '}
      {toggleChord} for details · /sandbox to disable
    </Text>
  )
}
