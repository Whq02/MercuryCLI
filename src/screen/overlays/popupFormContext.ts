import { createContext, useContext } from 'react'
import { useClaim } from '../effects/effects.js'

export const PopupFormContext = createContext(false)

type PopupCompact = { compact: boolean; setMarker: (marker: string | null) => void }

export const PopupCompactContext = createContext<PopupCompact>({ compact: false, setMarker: () => {} })

export function usePopupCompact(): PopupCompact {
  return useContext(PopupCompactContext)
}

export function usePopupMarker(marker: string | null): void {
  const { setMarker } = usePopupCompact()
  useClaim(() => {
    setMarker(marker)
    return () => setMarker(null)
  }, [setMarker, marker])
}
