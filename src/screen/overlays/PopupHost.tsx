import { type ReactNode, type RefObject, useCallback, useContext, useRef, useSyncExternalStore } from 'react'
import { ScreenInstanceContext } from '../renderer/elements/ScreenInstanceContext.js'
import { elementScreenLeft, elementScreenTop, measureElement, type DOMElement } from '../themedRenderer.js'
import type { PopupBand, PopupBounds } from './PopupGutter.js'

export type MeasuredHost = PopupBounds & { band: PopupBand | null; bandRows: number }

export function popupHostBounds(element: DOMElement, framed: boolean): PopupBounds {
  const inset = framed ? 1 : 0
  const { width, height } = measureElement(element)
  return { left: elementScreenLeft(element) + inset, top: elementScreenTop(element) + inset, columns: Math.max(0, width - 2 * inset), rows: Math.max(0, height - 2 * inset) }
}

export function PopupHost({ hostRef, bandRef, framed = false, children }: {
  hostRef: RefObject<DOMElement | null>
  bandRef?: RefObject<DOMElement | null>
  framed?: boolean
  children: (host: MeasuredHost | null) => ReactNode
}): ReactNode {
  const screen = useContext(ScreenInstanceContext)
  const cached = useRef<MeasuredHost | null>(null)
  const subscribe = useCallback((listener: () => void) => screen?.subscribeLayout(listener) ?? (() => {}), [screen])
  const read = () => {
    const element = hostRef.current
    if (!element) return null
    const last = cached.current
    const bounds = popupHostBounds(element, framed)
    const strip = bandRef?.current
    const height = strip ? measureElement(strip).height : 0
    const band = strip && height > 0 ? { top: elementScreenTop(strip), rows: height } : null
    const bandRows = strip ? height || last?.bandRows || 0 : 0
    if (last && last.left === bounds.left && last.top === bounds.top && last.columns === bounds.columns && last.rows === bounds.rows && last.band?.top === band?.top && last.band?.rows === band?.rows && last.bandRows === bandRows) return last
    return cached.current = { ...bounds, band, bandRows }
  }
  return children(useSyncExternalStore(subscribe, read))
}
