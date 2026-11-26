import * as React from 'react'
import { useClaim } from '../effects/effects.js'
import type { MeasuredHost } from './PopupHost.js'
import type { ScrollBoxHandle } from '../renderer/elements/ScrollBox.js'
import { ModalContext } from './modalContext.js'
import { useTerminalSize } from '../fullscreen-layout/useTerminalSize.js'
import { claimModelPickerPopup, releaseModelPickerPopup } from '../cockpit/modelPickerPopup.js'
import { MODEL_PICKER_PANEL } from '../../models/facts/modelPickerGroups.js'
import { panelWidth } from '../widgets/geometry.js'
import { modelPickerCentred } from '../../commands/model/picker/MercuryModelPicker.js'
import { PopupGutter, popupCover, type PopupBounds, popupGeometry } from './PopupGutter.js'

const MODEL_PICKER_POPUP_MIN_ROWS = 10
const MODEL_PICKER_POPUP_SPARE_ROWS = 7

type ModelPickerPopupGeometry = { left: number; top: number; width: number; rows: number; columns: number }

export function modelPickerPopupGeometry(host: PopupBounds, terminalRows: number, centred = true): ModelPickerPopupGeometry {
  const width = panelWidth(host.columns, MODEL_PICKER_PANEL)
  const budget = Math.max(MODEL_PICKER_POPUP_MIN_ROWS, terminalRows - MODEL_PICKER_POPUP_SPARE_ROWS)
  const preferredTop = Math.max(host.top + 1, Math.floor((terminalRows - budget) / 2))
  const rows = Math.max(0, Math.min(budget, host.top + host.rows - 1 - preferredTop))
  return { ...popupGeometry(host, { width, rows }, preferredTop, centred), columns: host.columns }
}

export function ModelPickerPopupLease({ children }: { children: React.ReactNode }): React.ReactNode {
  useClaim(() => {
    claimModelPickerPopup()
    return () => releaseModelPickerPopup()
  }, [])
  return <>{children}</>
}

export function ModelPickerPopupSlot({
  host,
  scrollRef,
  children,
}: {
  host: MeasuredHost | null
  scrollRef: React.RefObject<ScrollBoxHandle | null> | null
  children: React.ReactNode
}): React.ReactNode {
  const { rows: terminalRows } = useTerminalSize()
  if (!host) return null
  const geometry = modelPickerPopupGeometry(host, terminalRows, modelPickerCentred())
  return (
    <PopupGutter {...geometry} cover={popupCover(host, geometry, host.band)}>
      <ModalContext.Provider value={{ rows: geometry.rows, columns: geometry.columns, scrollRef }}>
        {children}
      </ModalContext.Provider>
    </PopupGutter>
  )
}
