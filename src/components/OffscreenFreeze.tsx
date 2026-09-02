
import React, { useContext, useRef } from 'react'
import { Box } from '../ink.js'
import { useTerminalViewport } from '../ink/hooks/use-terminal-viewport.js'
import { InVirtualListContext } from './messageActions.js'

export function OffscreenFreeze({
  children,
}: {
  children: React.ReactNode
}): React.ReactNode {
  const [ref, entry] = useTerminalViewport()
  const lastOnScreenRef = useRef<React.ReactNode>(children)
  const inVirtualList = useContext(InVirtualListContext)

  if (inVirtualList) return <>{children}</>

  if (entry.isVisible) {
    lastOnScreenRef.current = children
  }

  return <Box ref={ref}>{entry.isVisible ? children : lastOnScreenRef.current}</Box>
}

export default OffscreenFreeze
