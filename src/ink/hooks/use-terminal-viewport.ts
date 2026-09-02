
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
