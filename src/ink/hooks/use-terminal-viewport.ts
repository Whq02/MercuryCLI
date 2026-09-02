// Layout-phase "is this element on screen" detector, scroll-container aware.
// The measurement runs on EVERY render in the layout phase and only writes a
// ref — never setState (that created update loops with sibling layout
// effects); the entry object is replaced only when visibility flips, so its
// identity is stable and callers may hold it. The value is advisory: a
// render reads the previous pass's verdict.

import { useCallback, useContext, useLayoutEffect, useRef } from 'react'
import { TerminalSizeContext } from '../components/TerminalSizeContext.js'
import type { DOMElement } from '../dom.js'

export type ViewportEntry = { isVisible: boolean }

const VISIBLE: ViewportEntry = { isVisible: true }
const HIDDEN: ViewportEntry = { isVisible: false }

export function useTerminalViewport(): [
  ref: (el: DOMElement | null) => void,
  entry: ViewportEntry,
] {
  const size = useContext(TerminalSizeContext)
  const nodeRef = useRef<DOMElement | null>(null)
  const entryRef = useRef<ViewportEntry>(VISIBLE)

  const ref = useCallback((el: DOMElement | null) => {
    nodeRef.current = el
  }, [])

  useLayoutEffect(() => {
    const node = nodeRef.current
    const layout = node?.layoutNode
    if (!node || !layout || !size) return

    // Walk the DOM ancestor chain fresh each time (the layout tree can be
    // rebuilt); every layout-bearing ancestor adds its top, every scrolled
    // ancestor subtracts its offset (independent of having a layout node).
    let top = layout.getComputedTop()
    let root: DOMElement = node
    let ancestor = node.parentNode
    while (ancestor) {
      if (ancestor.layoutNode) {
        top += ancestor.layoutNode.getComputedTop()
        root = ancestor
      }
      const scrollTop = ancestor.scroll?.scrollTop
      if (scrollTop) top -= scrollTop
      ancestor = ancestor.parentNode
    }

    const screenHeight = root.layoutNode?.getComputedHeight() ?? 0
    const viewportHeight = size.rows
    const height = layout.getComputedHeight()
    // Overflow scrolls one EXTRA row into scrollback (the frame-end cursor
    // restore); the frame writer counts it the same way — disagreeing here
    // makes a boundary element's animation force full resets (flicker).
    const overflow = screenHeight > viewportHeight
    const scrolledOff = overflow ? screenHeight - viewportHeight + 1 : 0
    const viewportTop = scrolledOff
    const viewportBottom = scrolledOff + viewportHeight
    const visible = top + height > viewportTop && top < viewportBottom
    if (visible !== entryRef.current.isVisible) {
      entryRef.current = visible ? VISIBLE : HIDDEN
    }
  })

  return [ref, entryRef.current]
}
