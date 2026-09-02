// Marks a subtree as living inside the bottom-anchored modal slot
// and publishes its inner size plus an optional scroll handle. The size
// resolver exists because the modal's inner area is strictly smaller than
// the terminal; components that cap their visible row count from raw
// terminal size overflow the slot without it. The "inside modal" flag also
// suppresses a second full-width divider — the layout already draws one.

import { createContext, useContext } from 'react'
import type { RefObject } from 'react'
import type { ScrollBoxHandle } from '../ink/components/ScrollBox.js'

type ModalContextValue = {
  rows: number
  columns: number
  scrollRef: RefObject<ScrollBoxHandle | null> | null
}

export const ModalContext = createContext<ModalContextValue | null>(null)

export function useIsInsideModal(): boolean {
  return useContext(ModalContext) !== null
}

/** Inner rows/columns when inside the modal, else the caller's fallback. */
export function useModalOrTerminalSize(fallback: {
  rows: number
  columns: number
}): { rows: number; columns: number } {
  const modal = useContext(ModalContext)
  if (modal === null) return fallback
  return { rows: modal.rows, columns: modal.columns }
}

export function useModalScrollRef(): RefObject<ScrollBoxHandle | null> | null {
  return useContext(ModalContext)?.scrollRef ?? null
}
