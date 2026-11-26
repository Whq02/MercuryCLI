import * as React from 'react'
import { useSyncExternalStore } from 'react'
import { Box } from '../themedRenderer.js'
import { useTerminalSize } from '../fullscreen-layout/useTerminalSize.js'
import type { MeasuredHost } from './PopupHost.js'
import {
  settingsPopupCompact,
  settingsPopupRequest,
  settingsPopupVersion,
  subscribeSettingsPopup,
  type SettingsPopupGeometry,
  type SettingsPopupRequest,
} from '../cockpit/settingsPopup.js'
import { RowErrorBoundary } from '../messages/RowErrorBoundary.js'
import { Settings } from '../settings/Settings.js'
import { FloatingPopup, POPUP_GUTTER, PopupGutter, popupGeometry, popupWidth } from './PopupGutter.js'
import { SETTINGS_POPUP_CHROME_ROWS, SETTINGS_POPUP_COMPACT_CHROME_ROWS } from './settingsPopupChrome.js'

export { SETTINGS_POPUP_CHROME_ROWS, SETTINGS_POPUP_COMPACT_CHROME_ROWS }

export type SettingsPopupPlacement = SettingsPopupGeometry & {
  left: number
  top: number | null
  rows: number | null
}

function centredTop(height: number, terminalRows: number): number {
  return Math.max(0, Math.ceil((terminalRows - Math.min(height, terminalRows)) / 2))
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

export function SettingsPopupSlot({ overlay, host }: { overlay: boolean; host?: MeasuredHost | null }): React.ReactNode {
  useSyncExternalStore(subscribeSettingsPopup, settingsPopupVersion, settingsPopupVersion)
  const request = settingsPopupRequest()
  const open = settingsPopupVersion()
  const { columns, rows: terminalRows } = useTerminalSize()
  if (request === null || host === null) return null
  const placement = host ?? { left: 0, top: 0, columns, rows: terminalRows }
  const geometry = settingsPopupGeometry(request, placement.columns, terminalRows, placement.left, placement)
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
  if (geometry.rows === null) return (
    <FloatingPopup host={placement} width={geometry.width}>
      {shell}
    </FloatingPopup>
  )
  return (
    <PopupGutter top={geometry.top ?? placement.top + POPUP_GUTTER} left={geometry.left} width={geometry.width} rows={Math.max(0, placement.rows - 2 * POPUP_GUTTER)}>
      {shell}
    </PopupGutter>
  )
}
