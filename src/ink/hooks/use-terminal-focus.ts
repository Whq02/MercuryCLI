
import { useContext } from 'react'
import TerminalFocusContext from '../components/TerminalFocusContext.js'

export function useTerminalFocus(): boolean {
  const { isTerminalFocused, focusState } = useContext(TerminalFocusContext)
  return isTerminalFocused || focusState === 'unknown'
}
