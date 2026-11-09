import * as React from 'react'
import { Box, type DOMElement } from '../ink.js'
import { estateGroundBg } from '../utils/mercuryTokens.js'
import { useMercuryTokens } from './mercury-ui/useMercuryTokens.js'

export const POPUP_GUTTER = 1
type PopupBounds = { left: number; top: number; columns: number; rows: number }
type PopupSize = { width: number; rows: number }
export const PopupFrameContext = React.createContext<PopupSize | null>(null)

export function popupWidth(requested: number, columns: number): number {
  return Math.max(0, Math.min(Math.floor(requested), Math.floor(columns) - 2 * POPUP_GUTTER))
}

export function popupGeometry(host: PopupBounds, requested: PopupSize, preferredTop?: number, centred = true): PopupSize & { left: number; top: number } {
  const width = popupWidth(requested.width, host.columns)
  const rows = Math.max(0, Math.min(Math.floor(requested.rows), Math.floor(host.rows) - 2 * POPUP_GUTTER))
  const left = host.left + (centred ? Math.max(POPUP_GUTTER, Math.floor((host.columns - width) / 2)) : POPUP_GUTTER)
  const top = Math.max(host.top + POPUP_GUTTER, Math.min(preferredTop ?? host.top + Math.ceil((host.rows - rows) / 2), host.top + host.rows - POPUP_GUTTER - rows))
  return { left, top, width, rows }
}

export type PopupBand = { top: number; rows: number }
type PopupCover = { left: number; top: number; width: number }
const POPUP_COVER_SLACK = 8

export function popupCover(host: PopupBounds, popup: { left: number; top: number; width: number }, band: PopupBand | null): PopupCover | undefined {
  if (band === null || band.rows <= 0) return undefined
  const coveredTop = popup.top - POPUP_GUTTER
  const slack = host.columns - (popup.width + 2 * POPUP_GUTTER)
  if (slack > POPUP_COVER_SLACK || coveredTop < band.top || coveredTop >= band.top + band.rows) return undefined
  return { left: host.left, top: Math.max(host.top, band.top), width: host.columns }
}

export function PopupGutter({ left, top, width, rows, cover, contentRef, children }: PopupSize & {
  left: number
  top: number
  cover?: PopupCover
  contentRef?: React.Ref<DOMElement>
  children: React.ReactNode
}): React.ReactNode {
  const tokens = useMercuryTokens()
  const ground = estateGroundBg(tokens)
  if (width < 2 || rows < 2) return null
  const groundLeft = cover !== undefined ? Math.min(cover.left, left - POPUP_GUTTER) : left - POPUP_GUTTER
  const groundTop = cover !== undefined ? Math.min(cover.top, top - POPUP_GUTTER) : top - POPUP_GUTTER
  const groundWidth = cover !== undefined ? Math.max(cover.left + cover.width, left + width + POPUP_GUTTER) - groundLeft : width + 2 * POPUP_GUTTER
  return (
    <Box position="absolute" left={groundLeft} top={groundTop} width={groundWidth} padding={POPUP_GUTTER} paddingTop={top - groundTop} paddingLeft={left - groundLeft} paddingRight={groundLeft + groundWidth - (left + width)} flexDirection="column" flexShrink={0} opaque overflow="hidden" {...(ground !== undefined ? { backgroundColor: ground } : {})}>
      <Box ref={contentRef} width={width} maxHeight={rows} flexDirection="column" flexShrink={0} overflow="hidden">
        <PopupFrameContext.Provider value={{ width, rows }}>{children}</PopupFrameContext.Provider>
      </Box>
    </Box>
  )
}

export function FloatingPopup({ host, width, top, children, ...frame }: {
  host: PopupBounds
  width: number
  top?: number
  children: React.ReactNode | ((size: PopupSize) => React.ReactNode)
  borderColor?: React.ComponentProps<typeof Box>['borderColor']
  paddingX?: number
}): React.ReactNode {
  const tokens = useMercuryTokens()
  const ground = estateGroundBg(tokens)
  const size = { width: popupWidth(width, host.columns), rows: Math.max(0, host.rows - 2 * POPUP_GUTTER) }
  const geometry = popupGeometry(host, { width, rows: size.rows }, top)
  if (size.width < 2 || size.rows < 2) return null
  return (
    <Box position="absolute" left={geometry.left - POPUP_GUTTER} top={host.top} width={size.width + 2 * POPUP_GUTTER} height={host.rows} flexDirection="column" justifyContent={top === undefined ? 'center' : undefined}>
      {top !== undefined ? <Box height={Math.max(0, top - host.top - POPUP_GUTTER)} minHeight={0} flexShrink={1} /> : null}
      <Box padding={POPUP_GUTTER} width={size.width + 2 * POPUP_GUTTER} flexDirection="column" flexShrink={0} opaque {...(ground !== undefined ? { backgroundColor: ground } : {})}>
        <Box width={size.width} maxHeight={size.rows} flexDirection="column" flexShrink={0} overflow="hidden">
          <PopupFrameContext.Provider value={size}>
            {frame.borderColor !== undefined ? (
              <Box width={size.width} maxHeight={size.rows} flexDirection="column" flexShrink={0} overflow="hidden" borderStyle="round" {...frame}>
                {typeof children === 'function' ? children(size) : children}
              </Box>
            ) : typeof children === 'function' ? children(size) : children}
          </PopupFrameContext.Provider>
        </Box>
      </Box>
    </Box>
  )
}
