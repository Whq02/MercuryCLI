// Portal channel letting content float above the prompt, escaping
// the layout's bottom-slot clip (the clip is load-bearing: without it a
// tall paste squashes the scroll region, and the renderer clips absolutely
// positioned descendants too). Data and setters live in SEPARATE contexts
// with stable setter identity, so a component that only publishes is never
// re-rendered by the value it published.

import React, {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from 'react'
import type { SuggestionItem } from '../components/PromptInput/PromptInputFooterSuggestions.js'

export type PromptOverlayData = {
  suggestions: SuggestionItem[]
  onPick?: (index: number) => void
  onHover?: (index: number) => void
  maxColumnWidth?: number
}

type Setter<T> = (data: T | null) => void

const DataContext = createContext<PromptOverlayData | null>(null)
const SetDataContext = createContext<Setter<PromptOverlayData> | null>(null)
const DialogContext = createContext<ReactNode>(null)
const SetDialogContext = createContext<Setter<ReactNode> | null>(null)

export function PromptOverlayProvider({
  children,
}: {
  children: ReactNode
}): React.ReactNode {
  const [data, setData] = useState<PromptOverlayData | null>(null)
  const [dialog, setDialog] = useState<ReactNode>(null)
  return (
    <SetDataContext.Provider value={setData}>
      <SetDialogContext.Provider value={setDialog}>
        <DataContext.Provider value={data}>
          <DialogContext.Provider value={dialog}>
            {children}
          </DialogContext.Provider>
        </DataContext.Provider>
      </SetDialogContext.Provider>
    </SetDataContext.Provider>
  )
}

export function usePromptOverlay(): PromptOverlayData | null {
  return useContext(DataContext)
}

export function usePromptOverlayDialog(): ReactNode {
  return useContext(DialogContext)
}

/** Register suggestion data; clears on unmount. Inert outside the provider
 *  (the non-fullscreen path renders inline instead). */
export function useSetPromptOverlay(data: PromptOverlayData | null): void {
  const set = useContext(SetDataContext)
  useEffect(() => {
    if (!set) return
    set(data)
    return () => set(null)
  }, [set, data])
}

/** Register a floating dialog node; clears on unmount. Inert outside the
 *  provider. */
export function useSetPromptOverlayDialog(node: ReactNode): void {
  const set = useContext(SetDialogContext)
  useEffect(() => {
    if (!set) return
    set(node)
    return () => set(null)
  }, [set, node])
}
