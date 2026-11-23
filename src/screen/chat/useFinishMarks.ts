import { useClaim } from '../effects/effects.js'
import { currentSurfaceRoute, subscribeSurfaceRoute } from '../routes/surfaceRoute.js'
import { splitActiveAt, subscribeSplitView } from '../concourse/splitView.js'
import { getFocusedSessionConnector, hasFocusedSession, subscribeFocusedSessionConnector } from '../../engine/connector/focusedConnector.js'
import { markSessionSeen } from '../concourse-model/concourseSnapshot.js'
import { useTerminalSize } from '../fullscreen-layout/useTerminalSize.js'
import { passedOver } from '../../platform/errors/passedOver.js'

function chatOnScreen(columns: number, rows: number): string | null {
  const route = currentSurfaceRoute()
  const shown = route.kind === 'repl' || (route.kind === 'concourse' && splitActiveAt(columns, rows))
  if (!shown || !hasFocusedSession()) return null
  return getFocusedSessionConnector().sessionId()
}

export function useFinishMarks(): void {
  const { columns, rows } = useTerminalSize()
  useClaim(() => {
    let shown = chatOnScreen(columns, rows)
    if (shown !== null) void markSessionSeen(shown).catch(passedOver)
    const sync = (): void => {
      const next = chatOnScreen(columns, rows)
      if (next === shown) return
      if (shown !== null) void markSessionSeen(shown).catch(passedOver)
      if (next !== null) void markSessionSeen(next).catch(passedOver)
      shown = next
    }
    const unsubscribe = [subscribeSurfaceRoute(sync), subscribeFocusedSessionConnector(sync), subscribeSplitView(sync)]
    return () => {
      for (const off of unsubscribe) off()
      if (shown !== null) void markSessionSeen(shown).catch(passedOver)
    }
  }, [columns, rows])
}
