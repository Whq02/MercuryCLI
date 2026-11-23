import { useCallback, useContext, useRef } from 'react'
import { useMeasure } from '../../hooks/effects.js'
import { LiveTerminalSizeContext, TerminalSizeContext } from '../components/TerminalSizeContext.js'
import { InkInstanceContext } from '../components/InkInstanceContext.js'
import type { DOMElement } from '../dom.js'

type ViewportEntry = { isVisible: boolean }

const VISIBLE: ViewportEntry = { isVisible: true }
const HIDDEN: ViewportEntry = { isVisible: false }

export function useTerminalViewport(): [
  ref: (el: DOMElement | null) => void,
  entry: ViewportEntry,
] {
  const elementRef = useRef<DOMElement | null>(null)
  const entryRef = useRef<ViewportEntry>(VISIBLE)
  const size = useContext(TerminalSizeContext)
  const liveSize = useContext(LiveTerminalSizeContext)
  const ink = useContext(InkInstanceContext)

  const ref = useCallback((el: DOMElement | null) => {
    elementRef.current = el
  }, [])

  useMeasure(() => {
    const el = elementRef.current
    if (!el || !el.layoutNode || !size) return

    let top = el.layoutNode.getComputedTop()
    let root: DOMElement = el
    let parent = el.parentNode
    while (parent) {
      if (parent.layoutNode) {
        top += parent.layoutNode.getComputedTop()
        root = parent
      }
      if (parent.scroll?.scrollTop) {
        top -= parent.scroll.scrollTop
      }
      parent = parent.parentNode
    }

    const rootHeight = root.layoutNode?.getComputedHeight() ?? 0
    const altScreen = ink?.isAltScreenActive === true
    const rows = altScreen ? (liveSize ?? size).rows : size.rows
    const viewStart = !altScreen && rootHeight > rows ? rootHeight - rows + 1 : 0
    const viewEnd = viewStart + rows
    const bottom = top + el.layoutNode.getComputedHeight()
    const isVisible = bottom > viewStart && top < viewEnd

    if (entryRef.current.isVisible !== isVisible) {
      entryRef.current = isVisible ? VISIBLE : HIDDEN
    }
  })

  return [ref, entryRef.current]
}
