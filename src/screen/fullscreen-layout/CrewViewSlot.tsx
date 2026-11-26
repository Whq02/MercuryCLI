import * as React from 'react'
import { useState, useSyncExternalStore } from 'react'
import { type DOMElement } from '../themedRenderer.js'
import type { ScrollBoxHandle } from '../renderer/elements/ScrollBox.js'
import { TerminalSizeContext } from '../renderer/elements/TerminalSizeContext.js'
import { useMeasure } from '../effects/effects.js'
import { useTerminalSize } from './useTerminalSize.js'
import { closeCrewView, crewViewVersion, isCrewViewOpen, subscribeCrewView } from '../cockpit/crewView.js'
import type { CommandPopupShape } from '../cockpit/commandPopup.js'
import { CrewView } from '../widgets/faces/CrewView.js'
import { modelPickerPopupGeometry, modelPickerPopupHost, popupBandBounds, type ModelPickerPopupHost } from '../overlays/ModelPickerPopupSlot.js'
import { PopupGutter, popupCover, popupWidth, type PopupBand } from '../overlays/PopupGutter.js'
import { ModalContext } from '../overlays/modalContext.js'
import { usePromptOverlayDialog } from '../overlays/promptOverlay.js'

const CREW_POPUP_WIDTH = 124
export const CREW_POPUP_WIDE = 140
const CREW_VIEW_CHROME = 4

type CrewPopupGeometry = { left: number; top: number; width: number; rows: number }
type CrewDoorModal = { shape: CommandPopupShape | null; scrollRef: React.RefObject<ScrollBoxHandle | null> | null; surfaceRef?: React.Ref<DOMElement>; node: React.ReactNode }

export function crewDoorShape(view: string, width = CREW_POPUP_WIDTH): CommandPopupShape {
  return { view, door: 'crew', width: () => width, rows: rows => rows }
}

function crewPopupGeometry(host: ModelPickerPopupHost, terminalRows: number, shape: CommandPopupShape | null): CrewPopupGeometry {
  const shared = modelPickerPopupGeometry(host, terminalRows)
  const width = popupWidth(shape === null ? CREW_POPUP_WIDTH : shape.width(host.columns), host.columns)
  const left = Math.max(0, Math.floor((host.columns - width) / 2))
  const rows = Math.min(shared.rows, host.top + host.rows - shared.top)
  return { left, top: Math.max(0, shared.top - host.top), width, rows: shape === null ? rows : Math.min(shape.rows(terminalRows), rows) }
}

export function CrewViewSlot({ hostRef, bandRef, framed, modal }: { hostRef: React.RefObject<DOMElement | null>; bandRef?: React.RefObject<DOMElement | null>; framed: boolean; modal: CrewDoorModal | null }): React.ReactNode {
  useSyncExternalStore(subscribeCrewView, crewViewVersion, crewViewVersion)
  const { rows: terminalRows } = useTerminalSize()
  const dialog = usePromptOverlayDialog()
  const carried: CrewDoorModal | null = modal ?? (dialog === null ? null : { shape: null, scrollRef: null, node: dialog })
  const open = carried !== null || isCrewViewOpen()
  const [host, setHost] = useState<ModelPickerPopupHost | null>(null)
  const [band, setBand] = useState<PopupBand | null>(null)
  useMeasure(() => {
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
  const geometry = crewPopupGeometry(host, terminalRows, carried === null ? null : carried.shape)
  const cover = popupCover(host, { left: host.left + geometry.left, top: host.top + geometry.top, width: geometry.width }, band)
  return (
    <PopupGutter {...geometry} contentRef={carried?.surfaceRef} cover={cover === undefined ? undefined : { left: cover.left - host.left, top: cover.top - host.top, width: cover.width, rows: cover.rows }}>
      <ModalContext.Provider value={{ columns: geometry.width, rows: geometry.rows, scrollRef: carried?.scrollRef ?? null }}>
        <TerminalSizeContext.Provider value={{ columns: geometry.width - (carried === null ? CREW_VIEW_CHROME : 0), rows: geometry.rows }}>
          {carried === null ? <CrewView onClose={closeCrewView} popup /> : carried.node}
        </TerminalSizeContext.Provider>
      </ModalContext.Provider>
    </PopupGutter>
  )
}
