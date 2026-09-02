// Two hooks over the renderer's selection state. Both degrade on the ABSENCE
// of a renderer instance in context — never on the screen mode (the
// renderer's own guarding is deliberately non-uniform, and on the main
// screen a real instance simply holds an empty selection).

import { useContext, useMemo, useSyncExternalStore } from 'react'
import { InkInstanceContext } from '../components/InkInstanceContext.js'
import { shiftAnchor, type FocusMove, type SelectionState } from '../geometry/selection.js'
import type Ink from '../ink.js'

export type SelectionApi = {
  /** Copy and clear the highlight. */
  copySelection: () => string
  /** Copy without clearing (copy-on-select). */
  copySelectionNoClear: () => string
  clearSelection: () => void
  hasSelection: () => boolean
  /** The raw mutable selection record (drag-to-scroll). */
  getState: () => SelectionState | null
  subscribe: (callback: () => void) => () => void
  /** Shift the ANCHOR row by a delta, clamped to a row range. */
  shiftAnchor: (dRow: number, minRow: number, maxRow: number) => void
  /** Shift BOTH ends by a delta, clamped to a row range (keyboard scroll). */
  shiftSelection: (dRow: number, minRow: number, maxRow: number) => void
  /** Keyboard extension: the anchor stays, the focus moves. */
  moveFocus: (move: FocusMove) => void
  /** Call BEFORE the scroll, while the screen still holds the outgoing rows. */
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
    // A pure geometry helper over the live record — hence the clamp range.
    shiftAnchor: (dRow, minRow, maxRow) => shiftAnchor(ink.selection, dRow, minRow, maxRow),
    shiftSelection: (dRow, minRow, maxRow) => ink.shiftSelectionForScroll(dRow, minRow, maxRow),
    moveFocus: move => ink.moveSelectionFocus(move),
    captureScrolledRows: (firstRow, lastRow, side) =>
      ink.captureScrolledRows(firstRow, lastRow, side),
    setSelectionBgColor: color => ink.setSelectionBgColor(color),
  }
}

/** A memoised accessor keyed on the renderer instance; a complete inert
 *  stand-in (never null) without one. */
export function useSelection(): SelectionApi {
  const ink = useContext(InkInstanceContext)
  return useMemo(() => (ink ? instanceApi(ink) : inertApi()), [ink])
}

/** Re-renders the caller when a selection is created or cleared. Without an
 *  instance it subscribes to a stable no-op and reports false, so hook order
 *  never changes with fullscreen state. */
export function useHasSelection(): boolean {
  const ink = useContext(InkInstanceContext)
  return useSyncExternalStore(
    ink ? ink.subscribeToSelectionChange : noopUnsubscribe,
    ink ? ink.hasTextSelection : returnFalse,
    ink ? ink.hasTextSelection : returnFalse,
  )
}
