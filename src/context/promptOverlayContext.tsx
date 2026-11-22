import React, {
  createContext,
  useContext,
  useState,
  type ReactNode,
} from 'react'
import { useClaim } from '../hooks/effects.js'
import type { SuggestionItem } from '../components/PromptInput/PromptInputFooterSuggestions.js'
import { notBuilt, type Unbuilt } from '../pi/holes.js'

type PromptOverlayData = Unbuilt

export function PromptOverlayProvider(arg0: {
  children: ReactNode
}): React.ReactNode {
  return notBuilt('src/context/promptOverlayContext.tsx:26')
}

export function usePromptOverlay(): PromptOverlayData | null {
  return notBuilt('src/context/promptOverlayContext.tsx:46')
}

export function usePromptOverlayDialog(): ReactNode {
  return notBuilt('src/context/promptOverlayContext.tsx:50')
}

export function useSetPromptOverlay(data: PromptOverlayData | null): void {
  return notBuilt('src/context/promptOverlayContext.tsx:54')
}
