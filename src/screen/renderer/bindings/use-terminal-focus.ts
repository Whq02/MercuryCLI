import { useContext } from 'react'
import TerminalFocusContext from '../elements/TerminalFocusContext.js'

export function useTerminalFocus(): boolean {
  const { isTerminalFocused, focusState } = useContext(TerminalFocusContext)
  return isTerminalFocused || focusState === 'unknown'
}
