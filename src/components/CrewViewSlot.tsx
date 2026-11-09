import * as React from 'react'
import { useLayoutEffect, useState, useSyncExternalStore } from 'react'
import { type DOMElement } from '../ink.js'
import { TerminalSizeContext } from '../ink/components/TerminalSizeContext.js'
import { useTerminalSize } from '../hooks/useTerminalSize.js'
import { closeCrewView, crewViewVersion, isCrewViewOpen, subscribeCrewView } from '../utils/cockpit/crewView.js'
import { CrewView } from './mercury-ui/screens/CrewView.js'
import { modelPickerPopupGeometry, modelPickerPopupHost, popupBandBounds, type ModelPickerPopupHost } from './ModelPickerPopupSlot.js'
import { PopupGutter, popupCover, popupWidth, type PopupBand } from './PopupGutter.js'
import { ModalContext } from '../context/modalContext.js'

const CREW_POPUP_WIDTH = 124

type CrewPopupGeometry = { left: number; top: number; width: number; rows: number }

function crewPopupGeometry(host: ModelPickerPopupHost, terminalRows: number): CrewPopupGeometry {
  const shared = modelPickerPopupGeometry(host, terminalRows)
  const width = popupWidth(CREW_POPUP_WIDTH, host.columns)
  const left = Math.max(0, Math.floor((host.columns - width) / 2))
  return { left, top: Math.max(0, shared.top - host.top), width, rows: Math.min(shared.rows, host.top + host.rows - shared.top) }
}

export function CrewViewSlot({ hostRef, bandRef, framed }: { hostRef: React.RefObject<DOMElement | null>; bandRef?: React.RefObject<DOMElement | null>; framed: boolean }): React.ReactNode {
  useSyncExternalStore(subscribeCrewView, crewViewVersion, crewViewVersion)
  const { rows: terminalRows } = useTerminalSize()
  const open = isCrewViewOpen()
  const [host, setHost] = useState<ModelPickerPopupHost | null>(null)
  const [band, setBand] = useState<PopupBand | null>(null)
  useLayoutEffect(() => {
    if (!open) return
    const element = hostRef.current
    if (!element) return
    const next = modelPickerPopupHost(element, framed)
    if (next === null) return
    if (host === null || host.left !== next.left || host.top !== next.top || host.columns !== next.columns || host.rows !== next.rows) setHost(next)
    const nextBand = popupBandBounds(bandRef?.current ?? null)
    if ((band === null) !== (nextBand === null) || (band !== null && nextBand !== null && (band.top !== nextBand.top || band.rows !== nextBand.rows))) setBand(nextBand)
  })
  if (!open || host === null) return null
  const geometry = crewPopupGeometry(host, terminalRows)
  const cover = popupCover(host, { left: host.left + geometry.left, top: host.top + geometry.top, width: geometry.width }, band)
  return (
    <PopupGutter {...geometry} cover={cover === undefined ? undefined : { left: cover.left - host.left, top: cover.top - host.top, width: cover.width }}>
      <ModalContext.Provider value={{ columns: geometry.width, rows: geometry.rows, scrollRef: null }}>
        <TerminalSizeContext.Provider value={{ columns: geometry.width - 4, rows: geometry.rows }}>
          <CrewView onClose={closeCrewView} popup />
        </TerminalSizeContext.Provider>
      </ModalContext.Provider>
    </PopupGutter>
  )
}
