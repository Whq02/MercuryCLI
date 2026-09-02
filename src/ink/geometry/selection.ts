export {
  clearSelection,
  comparePoints,
  createSelectionState,
  finishSelection,
  type FocusMove,
  hasSelection,
  moveFocus,
  type Point,
  selectionBounds,
  type SelectionState,
  setSelectionClipBand,
  startSelection,
  updateSelection,
} from './selection-model.js'
export { extendSelection, selectLineAt, selectWordAt, wordBoundsAt } from './word-line.js'
export { findPlainTextUrlAt } from './url.js'
export { captureScrolledRows, shiftAnchor, shiftSelection, shiftSelectionForFollow } from './shift.js'
export { extractRowText, getSelectedText, joinRows } from './extract.js'
export { applySelectionOverlay } from './overlay.js'
