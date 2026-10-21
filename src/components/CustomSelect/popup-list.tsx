import * as React from 'react'
import { Box, Text, useInput } from '../../ink.js'
import { InkInstanceContext } from '../../ink/components/InkInstanceContext.js'
import type { DOMElement } from '../../ink.js'
import type { ScrollBoxHandle } from '../../ink/components/ScrollBox.js'
import type { Key } from '../../ink/events/input-event.js'
import { paneWindow, type PaneWindow } from '../mercury-ui/paneWindow.js'
import { applyNavMotion, decodeNavKey } from '../mercury-ui/navSemantics.js'

export const POPUP_PAGE_HINT = 'pgup/pgdn page'

export function popupListWindow(total: number, cursor: number, rows: number): PaneWindow {
  return paneWindow(total, cursor, Math.max(1, rows))
}

export function popupListMotion(input: string, key: Key, cursor: number, total: number, rows: number): number | null {
  const action = decodeNavKey(input, key, { orientation: 'vertical', pageKeys: true })
  const origin = cursor < 0 && action === 'movePrevious' ? total : cursor
  return action === null ? null : applyNavMotion(action, origin, total, { orientation: 'vertical', pageSize: Math.max(1, rows) })
}

export function PopupListViewport({ above, below, rows, children }: {
  above: number
  below: number
  rows: number
  children: React.ReactNode
}): React.ReactNode {
  const scrolls = above > 0 || below > 0
  const bodyRef = React.useRef<DOMElement | null>(null)
  const ink = React.useContext(InkInstanceContext)
  const [measured, setMeasured] = React.useState(0)
  const measure = React.useCallback(() => {
    const next = Math.ceil(bodyRef.current?.layoutNode?.getComputedHeight() ?? 0)
    setMeasured(current => current === next ? current : next)
  }, [])
  React.useLayoutEffect(measure)
  React.useEffect(() => ink?.subscribeFrame(measure), [ink, measure])
  const height = Math.max(1, measured || rows)
  return (
    <Box flexShrink={0}>
      <Box ref={bodyRef} alignSelf="flex-start" flexDirection="column" flexGrow={1} flexShrink={1} flexBasis={0} minWidth={0}>{children}</Box>
      {scrolls ? (
        <Box flexDirection="column" width={1} height={height} flexShrink={0}>
          <Text dimColor>{Array.from({ length: height }, (_, index) => index === 0 && above > 0 ? '↑' : index === height - 1 && below > 0 ? '↓' : ' ').join('\n')}</Text>
        </Box>
      ) : null}
    </Box>
  )
}

export function usePopupListNavigation(cursor: number, total: number, rows: number | (() => number), move: (index: number) => void, active = true, pagesOnly = false): void {
  const liveCursor = React.useRef(cursor)
  liveCursor.current = cursor
  useInput((input, key, event) => {
    if (pagesOnly && !key.pageUp && !key.pageDown) return
    const target = popupListMotion(input, key, liveCursor.current, total, typeof rows === 'function' ? rows() : rows)
    if (target === null) return
    event.stopImmediatePropagation()
    liveCursor.current = target
    move(target)
  }, { isActive: active })
}

export function usePopupListPaging(cursor: number, total: number, rows: number | (() => number), move: (index: number) => void, active = true): void {
  usePopupListNavigation(cursor, total, rows, move, active, true)
}

export function usePopupScrollWindow(ref: React.RefObject<ScrollBoxHandle | null>): { top: number; total: number; rows: number } {
  const ink = React.useContext(InkInstanceContext)
  const [view, setView] = React.useState({ top: 0, total: 0, rows: 0 })
  const measure = React.useCallback(() => {
    const body = ref.current
    if (!body) return
    const next = { top: body.getScrollTop(), total: body.getFreshScrollHeight(), rows: body.getViewportHeight() }
    setView(current => current.top === next.top && current.total === next.total && current.rows === next.rows ? current : next)
  }, [ref])
  React.useLayoutEffect(measure)
  React.useEffect(() => ink?.subscribeFrame(measure), [ink, measure])
  return view
}

export function PopupScrollViewport({ scrollRef, children }: { scrollRef: React.RefObject<ScrollBoxHandle | null>; children: React.ReactNode | ((scrolls: boolean) => React.ReactNode) }): React.ReactNode {
  const view = usePopupScrollWindow(scrollRef)
  return <PopupListViewport above={view.top} below={Math.max(0, view.total - view.top - view.rows)} rows={view.rows}>{typeof children === 'function' ? children(view.total > view.rows) : children}</PopupListViewport>
}
