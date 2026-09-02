// Terminal dimensions from the renderer's size context. Throws
// outside the app root — a silent default would produce wrong layouts.

import { useContext } from 'react'
import { TerminalSizeContext } from '../ink/components/TerminalSizeContext.js'
import type { TerminalSize } from '../ink/components/TerminalSizeContext.js'

export function useTerminalSize(): TerminalSize {
  const size = useContext(TerminalSizeContext)
  if (size === null) {
    throw new Error('useTerminalSize must be used within the app root')
  }
  return size
}
