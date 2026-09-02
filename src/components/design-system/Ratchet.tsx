
import React, { useLayoutEffect, useRef, useState } from 'react'
import { Box } from '../../ink.js'
import type { DOMElement } from '../../ink/dom.js'
import measureElement from '../../ink/measure-element.js'
import { useTerminalViewport } from '../../ink/hooks/use-terminal-viewport.js'
import { useTerminalSize } from '../../hooks/useTerminalSize.js'

export function Ratchet({
  children,
  lock = 'always',
}: {
  children?: React.ReactNode
  lock?: 'always' | 'offscreen'
}): React.ReactNode {
  const { rows } = useTerminalSize()
  const rowsRef = useRef(rows)
  rowsRef.current = rows
  const innerRef = useRef<DOMElement | null>(null)
  const [tallest, setTallest] = useState(0)
  const [viewportRef, viewport] = useTerminalViewport()

  useLayoutEffect(() => {
    const node = innerRef.current
    if (!node) return
    const { height } = measureElement(node)
    if (typeof height === 'number' && height > 0) {
      const capped = Math.min(height, rowsRef.current)
      setTallest(current => (capped > current ? capped : current))
    }
  })

  const engaged = lock === 'always' || !viewport.isVisible
  return (
    <Box
      ref={viewportRef}
      flexDirection="column"
      minHeight={engaged && tallest > 0 ? tallest : undefined}
    >
      <Box ref={innerRef} flexDirection="column">
        {children}
      </Box>
    </Box>
  )
}

export default Ratchet
