import * as React from 'react'
import { useMemo, useRef } from 'react'
import { useInput } from '../ink.js'
import ScrollBox, { type ScrollBoxHandle } from '../ink/components/ScrollBox.js'
import CursorDeclarationContext from '../ink/components/CursorDeclarationContext.js'
import { TerminalSizeContext } from '../ink/components/TerminalSizeContext.js'
import { ModalContext } from '../context/modalContext.js'
import { PopupFormContext } from '../context/popupFormContext.js'
import { useCursorFollow } from './mercury-ui/useCursorFollow.js'
import { PopupScrollViewport } from './CustomSelect/popup-list.js'

const REST_ON_CLEAR = { restOnClear: true }

export function PopupForm({ width, rows, children, scrollRef: hostScrollRef, bodyOwnsPageKeys = false }: { width: number; rows: number; children: React.ReactNode; scrollRef?: React.RefObject<ScrollBoxHandle | null>; bodyOwnsPageKeys?: boolean }): React.ReactNode {
  const ownScrollRef = useRef<ScrollBoxHandle | null>(null)
  const scrollRef = hostScrollRef ?? ownScrollRef
  const setCursor = useCursorFollow(scrollRef, { rows, width }, REST_ON_CLEAR)
  useInput((_input, key, event) => {
    const body = scrollRef.current
    if (bodyOwnsPageKeys || !body || !(key.pageUp || key.pageDown)) return
    event.stopImmediatePropagation()
    body.scrollBy((key.pageUp ? -1 : 1) * Math.max(1, body.getViewportHeight() - 1))
  })
  const size = useMemo(() => ({ columns: width, rows }), [width, rows])
  return (
    <ModalContext.Provider value={{ ...size, scrollRef }}>
      <TerminalSizeContext.Provider value={size}>
        <PopupFormContext.Provider value={true}>
          <CursorDeclarationContext.Provider value={setCursor}>
            <PopupScrollViewport scrollRef={scrollRef}>{scrolls => (
              <ScrollBox ref={scrollRef} flexDirection="column" height={rows} minHeight={0} width={Math.max(1, width - (scrolls ? 1 : 0))}>
                {children}
              </ScrollBox>
            )}</PopupScrollViewport>
          </CursorDeclarationContext.Provider>
        </PopupFormContext.Provider>
      </TerminalSizeContext.Provider>
    </ModalContext.Provider>
  )
}
