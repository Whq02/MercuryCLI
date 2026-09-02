// ============================================================================
//  geometry/selection.ts — T7: the selection package
//  surface.
//
//  One import site for the selection system's consumers (ink.tsx facade
//  methods, App.tsx mouse routing, the overlay pass, the keybinding
//  handlers, the provers). The owners: selection-model (state +
//  lifecycle) · word-line (multi-click) · url (Cmd+Click fallback) ·
//  shift (scroll tracking + capture, on the offscreen ledger) · extract
//  (copy truth) · overlay (the highlight). `isCellSelected` from the old
//  body is deliberately DROPPED — zero consumers (the render side paints
//  through the overlay).
// ============================================================================
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
