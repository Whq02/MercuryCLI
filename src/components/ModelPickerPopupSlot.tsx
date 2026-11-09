import * as React from 'react'
import { useEffect, useLayoutEffect, useState } from 'react'
import { elementScreenLeft, elementScreenTop, measureElement, type DOMElement } from '../ink.js'
import type { ScrollBoxHandle } from '../ink/components/ScrollBox.js'
import { ModalContext } from '../context/modalContext.js'
import { useTerminalSize } from '../hooks/useTerminalSize.js'
import { claimModelPickerPopup, releaseModelPickerPopup } from '../utils/cockpit/modelPickerPopup.js'
import { MODEL_PICKER_PANEL } from '../utils/model/modelPickerGroups.js'
import { panelWidth } from './mercury-ui/geometry.js'
import { modelPickerCentred } from './MercuryModelPicker.js'
import { PopupGutter, popupCoverTop, popupGeometry, type PopupBand } from './PopupGutter.js'

const MODEL_PICKER_POPUP_MIN_ROWS = 10
const MODEL_PICKER_POPUP_SPARE_ROWS = 7

export type ModelPickerPopupHost = { left: number; top: number; columns: number; rows: number }

type ModelPickerPopupGeometry = { left: number; top: number; width: number; rows: number; columns: number }

export function modelPickerPopupHost(element: DOMElement, framed: boolean): ModelPickerPopupHost | null {
  const inset = framed ? 1 : 0
  const measured = measureElement(element)
  const columns = measured.width - 2 * inset
  const rows = measured.height - 2 * inset
  if (columns <= 0 || rows <= 0) return null
  return { left: elementScreenLeft(element) + inset, top: elementScreenTop(element) + inset, columns, rows }
}

export function popupBandBounds(element: DOMElement | null): PopupBand | null {
  if (element === null) return null
  const rows = measureElement(element).height
  return rows > 0 ? { top: elementScreenTop(element), rows } : null
}

export function modelPickerPopupGeometry(host: ModelPickerPopupHost, terminalRows: number, centred = true): ModelPickerPopupGeometry {
  const width = panelWidth(host.columns, MODEL_PICKER_PANEL)
  const budget = Math.max(MODEL_PICKER_POPUP_MIN_ROWS, terminalRows - MODEL_PICKER_POPUP_SPARE_ROWS)
  const preferredTop = Math.max(host.top + 1, Math.floor((terminalRows - budget) / 2))
  const rows = Math.max(0, Math.min(budget, host.top + host.rows - 1 - preferredTop))
  return { ...popupGeometry(host, { width, rows }, preferredTop, centred), columns: host.columns }
}

export function ModelPickerPopupLease({ children }: { children: React.ReactNode }): React.ReactNode {
  useEffect(() => {
    claimModelPickerPopup()
    return () => releaseModelPickerPopup()
  }, [])
  return <>{children}</>
}

export function ModelPickerPopupSlot({
  hostRef,
  bandRef,
  framed,
  scrollRef,
  children,
}: {
  hostRef: React.RefObject<DOMElement | null>
  bandRef?: React.RefObject<DOMElement | null>
  framed: boolean
  scrollRef: React.RefObject<ScrollBoxHandle | null> | null
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
  const geometry = modelPickerPopupGeometry(host, terminalRows, modelPickerCentred())
  return (
    <PopupGutter {...geometry} coverTop={popupCoverTop(host, geometry, band)}>
      <ModalContext.Provider value={{ rows: geometry.rows, columns: geometry.columns, scrollRef }}>
        {children}
      </ModalContext.Provider>
    </PopupGutter>
  )
}
