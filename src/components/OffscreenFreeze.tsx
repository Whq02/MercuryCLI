// Rows scrolled above the terminal viewport into native scrollback cannot be
// patched in place — any change to them costs a whole-screen repaint. While
// the subtree is off screen this wrapper keeps returning the SAME children
// element object it last saw on screen, so the reconciler's identity check
// skips the subtree and the frame diff for it stays empty. Element identity,
// not just output, is the contract.

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
  // Inside a virtual list the scroll container already clips to the viewport
  // — there is no scrollback to protect, and freezing there breaks
  // click-to-expand (the visibility test and the virtual scroll position can
  // disagree).
  const inVirtualList = useContext(InVirtualListContext)

  if (inVirtualList) return <>{children}</>

  if (entry.isVisible) {
    // Only one element is remembered, so the render after coming back into
    // view already carries current children.
    lastOnScreenRef.current = children
  }

  return <Box ref={ref}>{entry.isVisible ? children : lastOnScreenRef.current}</Box>
}

export default OffscreenFreeze
