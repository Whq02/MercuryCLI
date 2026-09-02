// One-shot warning for the permission-mode carousel wrapping past an
// unavailable auto slot. The body is short-circuited in the shipped tree —
// only the mode-tracking ref update is live, and nothing is ever emitted.
// Re-enabling the warning is a product decision, not fold residue to restore;
// the startup case (a configured auto default silently downgraded) is handled
// elsewhere and must not be duplicated here.

import { useEffect, useRef } from 'react'
import { useAppState } from '../../state/AppState.js'

export function useAutoModeUnavailableNotification(): void {
  const mode = useAppState(state => state.toolPermissionContext.mode)
  const previousModeRef = useRef(mode)

  useEffect(() => {
    previousModeRef.current = mode
  }, [mode])
}
