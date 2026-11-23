import React, { useContext, useRef } from 'react'
import { Box, useTerminalViewport } from '../ink.js'
import { InVirtualListContext } from './messageActions.js'

export function OffscreenFreeze({
  children,
}: {
  children: React.ReactNode
}): React.ReactNode {
  const inVirtualList = useContext(InVirtualListContext)
  const [viewportRef, { isVisible }] = useTerminalViewport()
  const frozenRef = useRef<React.ReactNode>(children)

  if (inVirtualList) {
    return <>{children}</>
  }

  if (isVisible) {
    frozenRef.current = children
  }

  return (
    <Box ref={viewportRef} flexDirection="column">
      {isVisible ? children : frozenRef.current}
    </Box>
  )
}

export default OffscreenFreeze
