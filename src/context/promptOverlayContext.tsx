import React, {
  createContext,
  useContext,
  useState,
  type ReactNode,
} from 'react'
import { useClaim } from '../hooks/effects.js'
import type { SuggestionItem } from '../components/PromptInput/PromptInputFooterSuggestions.js'

type PromptOverlayData = {
  suggestions: SuggestionItem[]
  onPick?: (index: number) => void
  onHover?: (index: number) => void
  maxColumnWidth?: number
  maxRows?: number
}

const DataContext = createContext<PromptOverlayData | null>(null)
const SetDataContext = createContext<((data: PromptOverlayData | null) => void) | null>(null)
const DialogContext = createContext<ReactNode>(null)
const SetDialogContext = createContext<((dialog: ReactNode) => void) | null>(null)

export function PromptOverlayProvider({ children }: {
  children: ReactNode
}): React.ReactNode {
  const [data, setData] = useState<PromptOverlayData | null>(null)
  const [dialog, setDialog] = useState<ReactNode>(null)
  return (
    <DataContext.Provider value={data}>
      <SetDataContext.Provider value={setData}>
        <DialogContext.Provider value={dialog}>
          <SetDialogContext.Provider value={setDialog}>{children}</SetDialogContext.Provider>
        </DialogContext.Provider>
      </SetDataContext.Provider>
    </DataContext.Provider>
  )
}

export function usePromptOverlay(): PromptOverlayData | null {
  return useContext(DataContext)
}

export function usePromptOverlayDialog(): ReactNode {
  return useContext(DialogContext)
}

export function useSetPromptOverlay(data: PromptOverlayData | null): void {
  const setData = useContext(SetDataContext)
  useClaim(() => {
    if (setData === null) return undefined
    setData(data)
    return () => setData(null)
  }, [setData, data])
}
