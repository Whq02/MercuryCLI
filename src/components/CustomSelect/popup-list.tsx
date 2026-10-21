import * as React from 'react'
import { Box, Text, useInput } from '../../ink.js'
import { InkInstanceContext } from '../../ink/components/InkInstanceContext.js'
import type { DOMElement } from '../../ink.js'
import type { Key } from '../../ink/events/input-event.js'
import { paneWindow, type PaneWindow } from '../mercury-ui/paneWindow.js'
import { applyNavMotion, decodeNavKey } from '../mercury-ui/navSemantics.js'

export const POPUP_PAGE_HINT = 'pgup/pgdn page'

export function popupListWindow(total: number, cursor: number, rows: number): PaneWindow {
  return paneWindow(total, cursor, Math.max(1, rows))
}

export function popupListMotion(input: string, key: Key, cursor: number, total: number, rows: number): number | null {
  const action = decodeNavKey(input, key, { orientation: 'vertical', pageKeys: true })
  return action === null ? null : applyNavMotion(action, cursor, total, { orientation: 'vertical', pageSize: Math.max(1, rows) })
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

export function usePopupListPaging(cursor: number, total: number, rows: number | (() => number), move: (index: number) => void, active = true): void {
  useInput((input, key, event) => {
    if (!key.pageUp && !key.pageDown) return
    const target = popupListMotion(input, key, cursor, total, typeof rows === 'function' ? rows() : rows)
    event.stopImmediatePropagation()
    if (target !== null) move(target)
  }, { isActive: active })
}
