
import { useContext } from 'react'
import { LiveTerminalSizeContext, TerminalSizeContext } from '../ink/components/TerminalSizeContext.js'
import type { TerminalSize } from '../ink/components/TerminalSizeContext.js'

export function useTerminalSize(): TerminalSize {
  const size = useContext(TerminalSizeContext)
  if (size === null) {
    throw new Error('useTerminalSize must be used within the app root')
  }
  return size
}
export function useRealTerminalSize(): TerminalSize {
  const size = useContext(LiveTerminalSizeContext)
  if (size === null) throw new Error('useRealTerminalSize must be used within the app root')
  return size
}
