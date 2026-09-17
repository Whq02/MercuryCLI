import { useEffect } from 'react'
import { currentSurfaceRoute, subscribeSurfaceRoute } from '../context/surfaceRoute.js'
import { splitActiveAt, subscribeSplitView } from '../components/concourse/splitView.js'
import { getFocusedSessionConnector, hasFocusedSession, subscribeFocusedSessionConnector } from '../services/engine-connector/focusedConnector.js'
import { markSessionSeen } from '../services/concourse/concourseSnapshot.js'
import { useTerminalSize } from './useTerminalSize.js'

function chatOnScreen(columns: number, rows: number): string | null {
  const route = currentSurfaceRoute()
  const shown = route.kind === 'repl' || (route.kind === 'concourse' && splitActiveAt(columns, rows))
  if (!shown || !hasFocusedSession()) return null
  return getFocusedSessionConnector().sessionId()
}

export function useFinishMarks(): void {
  const { columns, rows } = useTerminalSize()
  useEffect(() => {
    let shown = chatOnScreen(columns, rows)
    if (shown !== null) void markSessionSeen(shown).catch(() => {})
    const sync = (): void => {
      const next = chatOnScreen(columns, rows)
      if (next === shown) return
      if (shown !== null) void markSessionSeen(shown).catch(() => {})
      if (next !== null) void markSessionSeen(next).catch(() => {})
      shown = next
    }
    const unsubscribe = [subscribeSurfaceRoute(sync), subscribeFocusedSessionConnector(sync), subscribeSplitView(sync)]
    return () => {
      for (const off of unsubscribe) off()
      if (shown !== null) void markSessionSeen(shown).catch(() => {})
    }
  }, [columns, rows])
}
