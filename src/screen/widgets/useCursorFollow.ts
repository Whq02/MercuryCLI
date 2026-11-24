import { useCallback, useContext, useRef } from 'react'
import { useSubscription, useTimer } from '../effects/effects.js'
import type { RefObject } from 'react'
import CursorDeclarationContext, { type CursorDeclaration, type CursorDeclarationSetter } from '../renderer/elements/CursorDeclarationContext.js'
import { ScreenInstanceContext } from '../renderer/elements/ScreenInstanceContext.js'
import type { ScrollBoxHandle } from '../renderer/elements/ScrollBox.js'
import { startTimeout, stopTimeout } from '../../platform/async/timers.js'

export function useCursorFollow(
  scrollRef: RefObject<ScrollBoxHandle | null>,
  viewport: { rows: number; width: number },
  options: { restOnClear?: boolean } = {},
): CursorDeclarationSetter {
  const publishCursor = useContext(CursorDeclarationContext)
  const instance = useContext(ScreenInstanceContext)
  const cursor = useRef<CursorDeclaration | null>(null)
  const followedTop = useRef<number | undefined>(undefined)
  const pending = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const restOnClear = options.restOnClear === true
  const spanOf = (current: CursorDeclaration, height: number): number =>
    Math.max(1, Math.min(height, Math.ceil(current.node.layoutNode?.getComputedHeight() ?? 1) - current.relativeY))
  const followNow = useCallback((): void => {
    const body = scrollRef.current
    const current = cursor.current
    if (!body || !current || !current.node.parentNode) return
    const elementTop = body.getElementTop(current.node)
    if (elementTop === undefined) return
    followedTop.current = elementTop
    const y = elementTop + current.relativeY
    const top = body.getScrollTop()
    const height = body.getViewportHeight()
    if (height <= 0) return
    const span = spanOf(current, height)
    if (y < top) body.scrollToElement(current.node, current.relativeY)
    else if (y + span > top + height) body.scrollToElement(current.node, current.relativeY - (height - span))
  }, [scrollRef])
  const follow = useCallback(() => {
    stopTimeout(pending.current)
    pending.current = startTimeout(followNow, 0)
  }, [followNow])
  useTimer(() => {
    stopTimeout(pending.current)
    const current = cursor.current
    if (current) {
      const rows = Math.max(1, viewport.rows)
      scrollRef.current?.scrollToElement(current.node, current.relativeY - (rows - spanOf(current, rows)))
      follow()
    }
    return () => stopTimeout(pending.current)
  }, [viewport.width, viewport.rows, scrollRef, follow])
  useSubscription(() => {
    if (!instance) return
    return instance.subscribeFrame(() => {
      const body = scrollRef.current
      const current = cursor.current
      if (!body || !current || !current.node.parentNode) return
      const elementTop = body.getElementTop(current.node)
      if (elementTop === undefined || elementTop === followedTop.current) return
      followNow()
    })
  }, [instance, scrollRef, followNow])
  return useCallback<CursorDeclarationSetter>((next, clearIfNode) => {
    publishCursor(next, clearIfNode)
    if (next === null) {
      if (cursor.current?.node === clearIfNode) {
        cursor.current = null
        followedTop.current = undefined
        if (restOnClear) {
          stopTimeout(pending.current)
          pending.current = startTimeout(() => {
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
