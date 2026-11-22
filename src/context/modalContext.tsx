import { createContext, useContext } from 'react'
import type { RefObject } from 'react'
import type { ScrollBoxHandle } from '../ink/components/ScrollBox.js'
import { notBuilt, unbuilt, type Unbuilt } from '../pi/holes.js'

export const ModalContext: Unbuilt = unbuilt('src/context/modalContext.tsx:12')

export function useIsInsideModal(): boolean {
  return notBuilt('src/context/modalContext.tsx:14')
}

export function useModalOrTerminalSize(fallback: {
  rows: number
  columns: number
}): { rows: number; columns: number } {
  return notBuilt('src/context/modalContext.tsx:18')
}

export function useModalScrollRef(): RefObject<ScrollBoxHandle | null> | null {
  return notBuilt('src/context/modalContext.tsx:27')
}
