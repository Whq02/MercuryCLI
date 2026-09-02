// Terminal focus context + its provider. The provider is a separate
// component so the app root never re-renders on focus changes; only
// context consumers do.

import React, { createContext, useMemo, useSyncExternalStore } from 'react'
import {
  getTerminalFocused,
  getTerminalFocusState,
  subscribeTerminalFocus,
  type TerminalFocusState,
} from '../session/focus-store.js'

export type { TerminalFocusState }

export type TerminalFocusContextProps = {
  readonly isTerminalFocused: boolean
  readonly focusState: TerminalFocusState
}

const TerminalFocusContext = createContext<TerminalFocusContextProps>({
  isTerminalFocused: true,
  focusState: 'unknown',
})

TerminalFocusContext.displayName = 'InternalTerminalFocusContext'

export function TerminalFocusProvider({
  children,
}: {
  children: React.ReactNode
}): React.ReactNode {
  const isTerminalFocused = useSyncExternalStore(
    subscribeTerminalFocus,
    getTerminalFocused,
    getTerminalFocused,
  )
  const focusState = useSyncExternalStore(
    subscribeTerminalFocus,
    getTerminalFocusState,
    getTerminalFocusState,
  )
  const value = useMemo(
    (): TerminalFocusContextProps => ({ isTerminalFocused, focusState }),
    [isTerminalFocused, focusState],
  )
  return (
    <TerminalFocusContext.Provider value={value}>
      {children}
    </TerminalFocusContext.Provider>
  )
}

export default TerminalFocusContext
