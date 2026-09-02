
import { useEffect, useRef } from 'react'
import { useAppState } from '../../state/AppState.js'

export function useAutoModeUnavailableNotification(): void {
  const mode = useAppState(state => state.toolPermissionContext.mode)
  const previousModeRef = useRef(mode)

  useEffect(() => {
    previousModeRef.current = mode
  }, [mode])
}
