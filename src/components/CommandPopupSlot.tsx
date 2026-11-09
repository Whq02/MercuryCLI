import * as React from 'react'
import { useEffect, useLayoutEffect, useState } from 'react'
import type { DOMElement } from '../ink.js'
import type { ScrollBoxHandle } from '../ink/components/ScrollBox.js'
import { ModalContext } from '../context/modalContext.js'
import { useTerminalSize } from '../hooks/useTerminalSize.js'
import { releaseCommandPopup, type CommandPopupShape } from '../utils/cockpit/commandPopup.js'
import { modelPickerPopupHost, popupBandBounds, type ModelPickerPopupHost } from './ModelPickerPopupSlot.js'
import { POPUP_GUTTER, PopupGutter, popupCover, popupGeometry, type PopupBand } from './PopupGutter.js'

type CommandPopupGeometry = { left: number; top: number; width: number; rows: number }

export function commandPopupGeometry(host: ModelPickerPopupHost, terminalRows: number, shape: CommandPopupShape): CommandPopupGeometry {
  const width = shape.width(host.columns)
  const rows = Math.max(0, Math.min(shape.rows(terminalRows), host.rows - 2 * POPUP_GUTTER))
  return popupGeometry(host, { width, rows })
}

export function CommandPopupLease({ token, children }: { token: number; children: React.ReactNode }): React.ReactNode {
  useEffect(() => () => releaseCommandPopup(token), [token])
  return <>{children}</>
}

export function CommandPopupSlot({
  hostRef,
  bandRef,
  framed,
  scrollRef,
  shape,
  children,
}: {
  hostRef: React.RefObject<DOMElement | null>
  bandRef?: React.RefObject<DOMElement | null>
  framed: boolean
  scrollRef: React.RefObject<ScrollBoxHandle | null> | null
  shape: CommandPopupShape
  children: React.ReactNode
}): React.ReactNode {
  const { columns, rows: terminalRows } = useTerminalSize()
  const [host, setHost] = useState<ModelPickerPopupHost | null>(null)
  const [band, setBand] = useState<PopupBand | null>(null)
  useLayoutEffect(() => {
    const element = hostRef.current
    const next = (element ? modelPickerPopupHost(element, framed) : null) ?? { left: 0, top: 0, columns, rows: terminalRows }
    if (host === null || host.left !== next.left || host.top !== next.top || host.columns !== next.columns || host.rows !== next.rows) setHost(next)
    const nextBand = popupBandBounds(bandRef?.current ?? null)
    if ((band === null) !== (nextBand === null) || (band !== null && nextBand !== null && (band.top !== nextBand.top || band.rows !== nextBand.rows))) setBand(nextBand)
  })
  if (host === null) return null
  const geometry = commandPopupGeometry(host, terminalRows, shape)
  return (
    <PopupGutter {...geometry} cover={popupCover(host, geometry, band)}>
      <ModalContext.Provider value={{ rows: geometry.rows, columns: geometry.width, scrollRef }}>
        {children}
      </ModalContext.Provider>
    </PopupGutter>
  )
}
