import * as React from 'react'
import { useCallback, useContext, useEffect, useMemo, useRef } from 'react'
import { useInput } from '../ink.js'
import ScrollBox, { type ScrollBoxHandle } from '../ink/components/ScrollBox.js'
import CursorDeclarationContext, { type CursorDeclaration, type CursorDeclarationSetter } from '../ink/components/CursorDeclarationContext.js'
import { TerminalSizeContext } from '../ink/components/TerminalSizeContext.js'
import { ModalContext } from '../context/modalContext.js'
import { PopupFormContext } from '../context/popupFormContext.js'

export function PopupForm({ width, rows, children, scrollRef: hostScrollRef }: { width: number; rows: number; children: React.ReactNode; scrollRef?: React.RefObject<ScrollBoxHandle | null> }): React.ReactNode {
  const ownScrollRef = useRef<ScrollBoxHandle | null>(null)
  const scrollRef = hostScrollRef ?? ownScrollRef
  const publishCursor = useContext(CursorDeclarationContext)
  const cursor = useRef<CursorDeclaration | null>(null)
  const pending = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
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
      if (height > 0 && (y < top || y >= top + height)) body.scrollToElement(current.node, current.relativeY - (y < top ? 0 : height - 1))
    }, 0)
  }, [scrollRef])
  useEffect(() => {
    clearTimeout(pending.current)
    const current = cursor.current
    if (current) scrollRef.current?.scrollToElement(current.node, current.relativeY - Math.max(0, rows - 1))
    return () => clearTimeout(pending.current)
  }, [width, rows, scrollRef])
  const setCursor = useCallback<CursorDeclarationSetter>((next, clearIfNode) => {
    publishCursor(next, clearIfNode)
    if (next === null) {
      if (cursor.current?.node === clearIfNode) {
        cursor.current = null
        clearTimeout(pending.current)
        pending.current = setTimeout(() => {
          if (cursor.current === null) scrollRef.current?.scrollTo(0)
        }, 0)
      }
      return
    }
    const changed = cursor.current === null || next.node !== cursor.current.node || next.relativeX !== cursor.current.relativeX || next.relativeY !== cursor.current.relativeY
    cursor.current = next
    if (changed) follow()
  }, [publishCursor, follow])
  useInput((_input, key, event) => {
    const body = scrollRef.current
    if (!body || !(key.pageUp || key.pageDown)) return
    event.stopImmediatePropagation()
    body.scrollBy((key.pageUp ? -1 : 1) * Math.max(1, body.getViewportHeight() - 1))
  })
  const size = useMemo(() => ({ columns: width, rows }), [width, rows])
  return (
    <ModalContext.Provider value={{ ...size, scrollRef }}>
      <TerminalSizeContext.Provider value={size}>
        <PopupFormContext.Provider value={true}>
          <CursorDeclarationContext.Provider value={setCursor}>
            <ScrollBox ref={scrollRef} flexDirection="column" height={rows} minHeight={0} width={width}>
              {children}
            </ScrollBox>
          </CursorDeclarationContext.Provider>
        </PopupFormContext.Provider>
      </TerminalSizeContext.Provider>
    </ModalContext.Provider>
  )
}
