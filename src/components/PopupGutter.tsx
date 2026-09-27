import * as React from 'react'
import { Box, type DOMElement } from '../ink.js'
import { estateGroundBg } from '../utils/mercuryTokens.js'
import { useMercuryTokens } from './mercury-ui/useMercuryTokens.js'

export const POPUP_GUTTER = 1
export type PopupBounds = { left: number; top: number; columns: number; rows: number }
export type PopupSize = { width: number; rows: number }
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

export function PopupGutter({ left, top, width, rows, contentRef, children }: PopupSize & {
  left: number
  top: number
  contentRef?: React.Ref<DOMElement>
  children: React.ReactNode
}): React.ReactNode {
  const tokens = useMercuryTokens()
  const ground = estateGroundBg(tokens)
  if (width < 2 || rows < 2) return null
  return (
    <Box position="absolute" left={left - POPUP_GUTTER} top={top - POPUP_GUTTER} width={width + 2 * POPUP_GUTTER} padding={POPUP_GUTTER} flexDirection="column" flexShrink={0} opaque overflow="hidden" {...(ground !== undefined ? { backgroundColor: ground } : {})}>
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
