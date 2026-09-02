
import { useContext, useMemo, useSyncExternalStore } from 'react'
import { InkInstanceContext } from '../components/InkInstanceContext.js'
import { shiftAnchor, type FocusMove, type SelectionState } from '../geometry/selection.js'
import type Ink from '../ink.js'

export type SelectionApi = {
  copySelection: () => string
  copySelectionNoClear: () => string
  clearSelection: () => void
  hasSelection: () => boolean
  getState: () => SelectionState | null
  subscribe: (callback: () => void) => () => void
  shiftAnchor: (dRow: number, minRow: number, maxRow: number) => void
  shiftSelection: (dRow: number, minRow: number, maxRow: number) => void
  moveFocus: (move: FocusMove) => void
  captureScrolledRows: (firstRow: number, lastRow: number, side: 'above' | 'below') => void
  setSelectionBgColor: (color: string) => void
}

const noop = (): void => {}
const noopUnsubscribe = (): (() => void) => noop
const returnFalse = (): boolean => false
const returnEmpty = (): string => ''

function inertApi(): SelectionApi {
  return {
    copySelection: returnEmpty,
    copySelectionNoClear: returnEmpty,
    clearSelection: noop,
    hasSelection: returnFalse,
    getState: () => null,
    subscribe: noopUnsubscribe,
    shiftAnchor: noop,
    shiftSelection: noop,
    moveFocus: noop,
    captureScrolledRows: noop,
    setSelectionBgColor: noop,
  }
}

function instanceApi(ink: Ink): SelectionApi {
  return {
    copySelection: () => ink.copySelection(),
    copySelectionNoClear: () => ink.copySelectionNoClear(),
    clearSelection: () => ink.clearTextSelection(),
    hasSelection: () => ink.hasTextSelection(),
    getState: () => ink.selection,
    subscribe: callback => ink.subscribeToSelectionChange(callback),
    shiftAnchor: (dRow, minRow, maxRow) => shiftAnchor(ink.selection, dRow, minRow, maxRow),
    shiftSelection: (dRow, minRow, maxRow) => ink.shiftSelectionForScroll(dRow, minRow, maxRow),
    moveFocus: move => ink.moveSelectionFocus(move),
    captureScrolledRows: (firstRow, lastRow, side) =>
      ink.captureScrolledRows(firstRow, lastRow, side),
    setSelectionBgColor: color => ink.setSelectionBgColor(color),
  }
}

export function useSelection(): SelectionApi {
  const ink = useContext(InkInstanceContext)
  return useMemo(() => (ink ? instanceApi(ink) : inertApi()), [ink])
}

export function useHasSelection(): boolean {
  const ink = useContext(InkInstanceContext)
  return useSyncExternalStore(
    ink ? ink.subscribeToSelectionChange : noopUnsubscribe,
    ink ? ink.hasTextSelection : returnFalse,
    ink ? ink.hasTextSelection : returnFalse,
  )
}
