import React, { createContext, useMemo, useSyncExternalStore } from 'react'
import {
  getTerminalFocused,
  getTerminalFocusState,
  subscribeTerminalFocus,
  type TerminalFocusState,
} from '../session/focus-store.js'
import { unbuilt, type Unbuilt } from '../../pi/holes.js'

export type { TerminalFocusState }

type TerminalFocusContextProps = Unbuilt

const TerminalFocusContext: Unbuilt = unbuilt('src/ink/components/TerminalFocusContext.tsx:17')

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
