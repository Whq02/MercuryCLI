import * as React from 'react'
import { useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react'
import { Box, elementScreenLeft, measureElement, type DOMElement } from '../ink.js'
import { useTerminalSize } from '../hooks/useTerminalSize.js'
import {
  settingsPopupRequest,
  settingsPopupVersion,
  subscribeSettingsPopup,
  type SettingsPopupGeometry,
  type SettingsPopupRequest,
} from '../utils/cockpit/settingsPopup.js'
import { Settings } from './Settings/Settings.js'

export const SETTINGS_POPUP_CHROME_ROWS = 7
export const SETTINGS_POPUP_MIN_WIDTH = 12

export type SettingsPopupPlacement = SettingsPopupGeometry & {
  left: number
  top: number | null
  rows: number | null
}

export function centredTop(height: number, terminalRows: number): number {
  return Math.max(0, Math.ceil((terminalRows - Math.min(height, terminalRows)) / 2))
}

export type SettingsPopupHost = { left: number; columns: number }

export function settingsPopupHost(element: DOMElement, framed: boolean): SettingsPopupHost | null {
  const inset = framed ? 1 : 0
  const columns = measureElement(element).width - 2 * inset
  if (columns <= 0) return null
  return { left: elementScreenLeft(element) + inset, columns }
}

export function settingsPopupGeometry(
  request: Pick<SettingsPopupRequest, 'width' | 'rows'>,
  columns: number,
  terminalRows: number,
  hostLeft = 0,
): SettingsPopupPlacement {
  const width = Math.min(request.width, Math.max(SETTINGS_POPUP_MIN_WIDTH, columns))
  const left = hostLeft + Math.max(0, Math.floor((columns - width) / 2))
  const rows =
    request.rows === null
      ? null
      : Math.max(SETTINGS_POPUP_CHROME_ROWS + 1, Math.min(request.rows, terminalRows))
  const rowBudget = Math.max(1, (rows ?? terminalRows) - SETTINGS_POPUP_CHROME_ROWS)
  const top = rows === null ? null : centredTop(rows, terminalRows)
  return { width, inner: width - 4, rowBudget, left, top, rows }
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
  const slotRef = useRef<DOMElement | null>(null)
  const [measured, setMeasured] = useState<number | null>(null)
  const [host, setHost] = useState<SettingsPopupHost | null>(null)
  const hosted = overlay && hostRef !== undefined
  useLayoutEffect(() => {
    if (!hosted || request === null) return
    const element = hostRef?.current
    const next = (element ? settingsPopupHost(element, framed) : null) ?? { left: 0, columns }
    if (host === null || host.left !== next.left || host.columns !== next.columns) setHost(next)
  })
  useLayoutEffect(() => {
    if (!overlay || request === null || request.rows !== null) return
    const element = slotRef.current
    if (!element) return
    const { height } = measureElement(element)
    if (height > 0 && height !== measured) setMeasured(height)
  })
  if (request === null) return null
  const placement = hosted ? host : null
  if (hosted && placement === null) return null
  const geometry =
    placement !== null
      ? settingsPopupGeometry(request, placement.columns, terminalRows, placement.left)
      : settingsPopupGeometry(request, columns, terminalRows)
  const shell = <Settings key={open} request={request} geometry={geometry} />
  if (!overlay) {
    return (
      <Box marginLeft={geometry.left} width={geometry.width} flexDirection="column" flexShrink={0}>
        {shell}
      </Box>
    )
  }
  const top = geometry.top ?? centredTop(measured ?? 0, terminalRows)
  return (
    <Box ref={slotRef} position="absolute" top={top} left={geometry.left} width={geometry.width} flexDirection="column" flexShrink={0}>
      {shell}
    </Box>
  )
}
