import * as React from 'react'
import { useLayoutEffect, useState, useSyncExternalStore } from 'react'
import { Box, elementScreenLeft, elementScreenTop, measureElement, type DOMElement } from '../ink.js'
import { useTerminalSize } from '../hooks/useTerminalSize.js'
import {
  settingsPopupCompact,
  settingsPopupRequest,
  settingsPopupVersion,
  subscribeSettingsPopup,
  type SettingsPopupGeometry,
  type SettingsPopupRequest,
} from '../utils/cockpit/settingsPopup.js'
import { RowErrorBoundary } from './RowErrorBoundary.js'
import { Settings } from './Settings/Settings.js'
import { FloatingPopup, POPUP_GUTTER, PopupGutter, popupGeometry, popupWidth } from './PopupGutter.js'

export const SETTINGS_POPUP_CHROME_ROWS = 7
export const SETTINGS_POPUP_COMPACT_CHROME_ROWS = 3
export const SETTINGS_POPUP_MIN_WIDTH = 12

export type SettingsPopupPlacement = SettingsPopupGeometry & {
  left: number
  top: number | null
  rows: number | null
}

export function centredTop(height: number, terminalRows: number): number {
  return Math.max(0, Math.ceil((terminalRows - Math.min(height, terminalRows)) / 2))
}

export type SettingsPopupHost = { left: number; columns: number; top?: number; rows?: number }

export function settingsPopupHost(element: DOMElement, framed: boolean): SettingsPopupHost | null {
  const inset = framed ? 1 : 0
  const measured = measureElement(element)
  const columns = measured.width - 2 * inset
  if (columns <= 0) return null
  const headerRows = framed ? 1 : 0
  const rows = Math.max(0, measured.height - 2 * inset - headerRows)
  return { left: elementScreenLeft(element) + inset, columns, top: elementScreenTop(element) + inset + headerRows, rows }
}

export function settingsPopupGeometry(
  request: Pick<SettingsPopupRequest, 'width' | 'rows'>,
  columns: number,
  terminalRows: number,
  hostLeft = 0,
  hostBand?: { top: number; rows: number },
): SettingsPopupPlacement {
  const host = { left: hostLeft, columns, top: hostBand?.top ?? 0, rows: hostBand?.rows ?? terminalRows }
  const available = popupWidth(columns, columns)
  const requestedWidth = typeof request.width === 'function' ? request.width(available) : request.width
  const geometry = popupGeometry(host, { width: requestedWidth, rows: request.rows ?? host.rows })
  const rows = request.rows === null ? null : geometry.rows
  const fullBudget = Math.max(0, geometry.rows - SETTINGS_POPUP_CHROME_ROWS)
  const compact = rows !== null && settingsPopupCompact(fullBudget)
  const rowBudget = compact ? Math.max(0, geometry.rows - SETTINGS_POPUP_COMPACT_CHROME_ROWS) : fullBudget
  const top = rows === null ? null : popupGeometry(host, geometry, centredTop(rows, terminalRows)).top
  return { width: geometry.width, inner: Math.max(0, geometry.width - 4), rowBudget, compact, left: geometry.left, top, rows }
}

export function SettingsPopupSlot({
  overlay,
  hostRef,
  framed = false,
}: {
  overlay: boolean
  hostRef?: React.RefObject<DOMElement | null>
  framed?: boolean
}): React.ReactNode {
  useSyncExternalStore(subscribeSettingsPopup, settingsPopupVersion, settingsPopupVersion)
  const request = settingsPopupRequest()
  const open = settingsPopupVersion()
  const { columns, rows: terminalRows } = useTerminalSize()
  const [host, setHost] = useState<SettingsPopupHost | null>(null)
  const hosted = overlay && hostRef !== undefined
  useLayoutEffect(() => {
    if (!hosted || request === null) return
    const element = hostRef?.current
    const next = (element ? settingsPopupHost(element, framed) : null) ?? { left: 0, columns }
    if (host === null || host.left !== next.left || host.columns !== next.columns || host.top !== next.top || host.rows !== next.rows) setHost(next)
  })
  if (request === null) return null
  const placement = hosted ? host : null
  if (hosted && placement === null) return null
  const band = placement !== null && placement.top !== undefined && placement.rows !== undefined ? { top: placement.top, rows: placement.rows } : undefined
  const geometry =
    placement !== null
      ? settingsPopupGeometry(request, placement.columns, terminalRows, placement.left, band)
      : settingsPopupGeometry(request, columns, terminalRows)
  const shell = (
    <RowErrorBoundary key={open} origin="settings-popup">
      <Settings key={open} request={request} geometry={geometry} />
    </RowErrorBoundary>
  )
  if (!overlay) {
    return (
      <Box marginLeft={geometry.left} width={geometry.width} flexDirection="column" flexShrink={0}>
        {shell}
      </Box>
    )
  }
  const hostTop = band?.top ?? 0
  const hostRows = band?.rows ?? terminalRows
  if (geometry.rows === null) return (
    <FloatingPopup host={{ left: placement?.left ?? 0, top: hostTop, columns: placement?.columns ?? columns, rows: hostRows }} width={geometry.width}>
      {shell}
    </FloatingPopup>
  )
  return (
    <PopupGutter top={geometry.top ?? hostTop + POPUP_GUTTER} left={geometry.left} width={geometry.width} rows={Math.max(0, hostRows - 2 * POPUP_GUTTER)}>
      {shell}
    </PopupGutter>
  )
}
