// ============================================================================
//  workbench/returnState — the attach/detach return-state seam (
//
//
//  When the operator leaves a board INTO a real surface (attach, deep-link,
//  folio drill), the origin is captured HERE — stable row key, active
//  section, the scoped composer drafts — so detach returns to the exact
//  item with drafts intact, including after the target settled. Module
//  state, per board surface: it survives the board's unmount (the board is
//  a transient view; the trail back is not). NOT persisted to disk — a
//  restart's recovery story is the snapshot path plus history recall
//  (Wave B), not this seam.
// ============================================================================

export interface BoardReturnState {
  /** The stable row key (the panes rowKey vocabulary) to restore selection to. */
  rowKey?: string
  /** The active section id at capture. */
  sectionId?: string
  /** Scoped composer drafts alive at capture, keyed by composer scope
   *  (e.g. 'dispatch'). The main composer's draft is NEVER here — it has
   *  its own owner and this seam must not create a second one. */
  drafts?: Record<string, string>
  atMs: number
}

const states = new Map<string, BoardReturnState>()

/** Capture the origin for a board surface ('workbench' · 'workflows' · …).
 *  MERGES over the stored record: a capture that carries no rowKey (a
 *  row-less exit) must not wipe the row the operator drilled from earlier
 *  (review finding); defined fields win, absent fields keep their truth. */
export function captureReturnState(surface: string, state: BoardReturnState): void {
  const prev = states.get(surface)
  states.set(surface, {
    ...prev,
    ...state,
    ...(state.rowKey === undefined && prev?.rowKey !== undefined ? { rowKey: prev.rowKey } : {}),
    ...(state.drafts === undefined && prev?.drafts !== undefined ? { drafts: prev.drafts } : {}),
  })
}

/** The stored origin, or null. Idempotent read — detach may consult it more
 *  than once (narrow re-mounts); clear explicitly when consumed. */
export function restoreReturnState(surface: string): BoardReturnState | null {
  return states.get(surface) ?? null
}

export function clearReturnState(surface: string): void {
  states.delete(surface)
}

/** Test seam. */
export function _resetReturnStateForTesting(): void {
  states.clear()
}
