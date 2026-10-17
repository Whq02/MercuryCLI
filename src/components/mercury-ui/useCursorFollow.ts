import { useCallback, useContext, useEffect, useRef } from 'react'
import type { RefObject } from 'react'
import CursorDeclarationContext, { type CursorDeclaration, type CursorDeclarationSetter } from '../../ink/components/CursorDeclarationContext.js'
import type { ScrollBoxHandle } from '../../ink/components/ScrollBox.js'

export function useCursorFollow(
  scrollRef: RefObject<ScrollBoxHandle | null>,
  viewport: { rows: number; width: number },
  options: { restOnClear?: boolean } = {},
): CursorDeclarationSetter {
  const publishCursor = useContext(CursorDeclarationContext)
  const cursor = useRef<CursorDeclaration | null>(null)
  const pending = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const restOnClear = options.restOnClear === true
  const follow = useCallback(() => {
    clearTimeout(pending.current)
    pending.current = setTimeout(() => {
      const body = scrollRef.current
      const current = cursor.current
      if (!body || !current || !current.node.parentNode) return
      const elementTop = body.getElementTop(current.node)
      if (elementTop === undefined) return
      const y = elementTop + current.relativeY
      const top = body.getScrollTop()
      const height = body.getViewportHeight()
      if (height <= 0) return
      const span = Math.max(1, Math.min(height, Math.ceil(current.node.layoutNode?.getComputedHeight() ?? 1) - current.relativeY))
      if (y < top) body.scrollToElement(current.node, current.relativeY)
      else if (y + span > top + height) body.scrollToElement(current.node, current.relativeY - (height - span))
    }, 0)
  }, [scrollRef])
  useEffect(() => {
    clearTimeout(pending.current)
    const current = cursor.current
    if (current) scrollRef.current?.scrollToElement(current.node, current.relativeY - Math.max(0, viewport.rows - 1))
    return () => clearTimeout(pending.current)
  }, [viewport.width, viewport.rows, scrollRef])
  return useCallback<CursorDeclarationSetter>((next, clearIfNode) => {
    publishCursor(next, clearIfNode)
    if (next === null) {
      if (cursor.current?.node === clearIfNode) {
        cursor.current = null
        if (restOnClear) {
          clearTimeout(pending.current)
          pending.current = setTimeout(() => {
            if (cursor.current === null) scrollRef.current?.scrollTo(0)
          }, 0)
        }
      }
      return
    }
    const changed = cursor.current === null || next.node !== cursor.current.node || next.relativeX !== cursor.current.relativeX || next.relativeY !== cursor.current.relativeY
    cursor.current = next
    if (changed) follow()
  }, [publishCursor, follow, scrollRef, restOnClear])
}
