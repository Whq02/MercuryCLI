import React, {
  createContext,
  useContext,
  useState,
  type ReactElement,
  type ReactNode,
} from 'react'
import { useClaim } from '../effects/effects.js'
import type { SuggestionItem } from '../composer/ComposerFooterSuggestions.js'

type PromptOverlayData = {
  suggestions: SuggestionItem[]
  onPick?: (index: number) => void
  onHover?: (index: number) => void
  maxColumnWidth?: number
  maxRows?: number
}

const DataContext = createContext<PromptOverlayData | null>(null)
const SetDataContext = createContext<((data: PromptOverlayData | null) => void) | null>(null)
const DialogContext = createContext<ReactElement | null>(null)
const SetDialogContext = createContext<((dialog: ReactElement | null) => void) | null>(null)

export function PromptOverlayProvider({ children }: {
  children: ReactNode
}): React.ReactNode {
  const [data, setData] = useState<PromptOverlayData | null>(null)
  const [dialog, setDialog] = useState<ReactElement | null>(null)
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

export function usePromptOverlayDialog(): ReactElement | null {
  return useContext(DialogContext)
}

export function useSetPromptOverlayDialog(dialog: ReactElement | null): void {
  const setDialog = useContext(SetDialogContext)
  useClaim(() => {
    if (setDialog === null) return undefined
    setDialog(dialog)
    return () => setDialog(null)
  }, [setDialog, dialog])
}

export function useSetPromptOverlay(data: PromptOverlayData | null): void {
  const setData = useContext(SetDataContext)
  useClaim(() => {
    if (setData === null) return undefined
    setData(data)
    return () => setData(null)
  }, [setData, data])
}
