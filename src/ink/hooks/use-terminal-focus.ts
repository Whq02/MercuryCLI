// Reads whether the terminal window currently has focus. Reports focused
// when the state is unknown: an application must never behave as blurred
// just because the terminal never reported focus. Focus facts arrive via
// DEC mode 1004 reporting; the input layer consumes those sequences and
// keeps them out of the keystroke stream.

import { useContext } from 'react'
import TerminalFocusContext from '../components/TerminalFocusContext.js'

export function useTerminalFocus(): boolean {
  const { isTerminalFocused, focusState } = useContext(TerminalFocusContext)
  return isTerminalFocused || focusState === 'unknown'
}
