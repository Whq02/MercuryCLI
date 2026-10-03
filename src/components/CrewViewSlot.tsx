import * as React from 'react'
import { useLayoutEffect, useState, useSyncExternalStore } from 'react'
import { type DOMElement } from '../ink.js'
import { TerminalSizeContext } from '../ink/components/TerminalSizeContext.js'
import { useTerminalSize } from '../hooks/useTerminalSize.js'
import { closeCrewView, crewViewVersion, isCrewViewOpen, subscribeCrewView } from '../utils/cockpit/crewView.js'
import { CrewView } from './mercury-ui/screens/CrewView.js'
import { modelPickerPopupGeometry, modelPickerPopupHost, type ModelPickerPopupHost } from './ModelPickerPopupSlot.js'
import { PopupGutter, popupWidth } from './PopupGutter.js'
import { ModalContext } from '../context/modalContext.js'

export const CREW_POPUP_WIDTH = 124

export type CrewPopupGeometry = { left: number; top: number; width: number; rows: number }

export function crewPopupGeometry(host: ModelPickerPopupHost, terminalRows: number): CrewPopupGeometry {
  const shared = modelPickerPopupGeometry(host, terminalRows)
  const width = popupWidth(CREW_POPUP_WIDTH, host.columns)
  const left = Math.max(0, Math.floor((host.columns - width) / 2))
  return { left, top: Math.max(0, shared.top - host.top), width, rows: Math.min(shared.rows, host.top + host.rows - shared.top) }
}

export function CrewViewSlot({ hostRef, framed }: { hostRef: React.RefObject<DOMElement | null>; framed: boolean }): React.ReactNode {
  useSyncExternalStore(subscribeCrewView, crewViewVersion, crewViewVersion)
  const { rows: terminalRows } = useTerminalSize()
  const open = isCrewViewOpen()
  const [host, setHost] = useState<ModelPickerPopupHost | null>(null)
  useLayoutEffect(() => {
    if (!open) return
    const element = hostRef.current
    if (!element) return
    const next = modelPickerPopupHost(element, framed)
    if (next === null) return
    if (host === null || host.left !== next.left || host.top !== next.top || host.columns !== next.columns || host.rows !== next.rows) setHost(next)
  })
  if (!open || host === null) return null
  const geometry = crewPopupGeometry(host, terminalRows)
  return (
    <PopupGutter {...geometry}>
      <ModalContext.Provider value={{ columns: geometry.width, rows: geometry.rows, scrollRef: null }}>
        <TerminalSizeContext.Provider value={{ columns: geometry.width - 4, rows: geometry.rows }}>
          <CrewView onClose={closeCrewView} popup />
        </TerminalSizeContext.Provider>
      </ModalContext.Provider>
    </PopupGutter>
  )
}
