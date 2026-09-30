import { createContext, useContext, useEffect } from 'react'

export const PopupFormContext = createContext(false)

export type PopupCompact = { compact: boolean; setMarker: (marker: string | null) => void }

export const PopupCompactContext = createContext<PopupCompact>({ compact: false, setMarker: () => {} })

export function usePopupCompact(): PopupCompact {
  return useContext(PopupCompactContext)
}

export function usePopupMarker(marker: string | null): void {
  const { setMarker } = usePopupCompact()
  useEffect(() => {
    setMarker(marker)
    return () => setMarker(null)
  }, [setMarker, marker])
}
