import { flagEnv } from '../../substrate/flagRegistry.js'
// ============================================================================
//  utils/cockpit/pointerShape — OSC 22 pointer-shape honesty.
//
//  The operator's report: the terminal pointer stays a text I-BEAM over the
//  whole TUI. With mouse tracking on, the app owns the pointer semantics —
//  an I-beam over a rail card or a banner advertises a selection that isn't
//  there. xterm's OSC 22 (pointerShape) lets an app pick the shape; kitty,
//  WezTerm, foot, Ghostty and xterm honor it, and terminals that don't
//  (Apple_Terminal among them) IGNORE the sequence by spec — so this is a
//  pure best-effort: 'text' over genuinely selectable cells, 'default' (the
//  arrow) everywhere else, silent no-op where unsupported.
//
//  The selectability truth is the renderer's own per-cell noSelect bitmap —
//  the SAME bitmap that scopes drag-copy — so the pointer can never promise
//  a selection drag-copy would refuse (one predicate, two consumers).
//
//  HONEST LIMIT (documented per the task's close-out contract): the shape is
//  per-HOVER-CELL, not per-widget; terminals without OSC 22 keep their own
//  pointer entirely — there is no DECSET to change that, and mouse-tracking
//  mode itself is global (regional tracking does not exist in the protocol).
// ============================================================================


export type PointerShape = 'text' | 'default'

/** Flag-gated, `MERCURY_POINTER_SHAPE=0` kills; re-read live (authority rule). */
export function pointerShapeEnabled(): boolean {
  if (flagEnv('MERCURY_POINTER_SHAPE') === '0') return false
  return true
}

let lastShape: PointerShape | null = null

/** OSC 22 bytes for a shape (BEL-terminated — the widest-parsed form). */
export function pointerShapeSeq(shape: PointerShape): string {
  return `\x1b]22;${shape}\x07`
}

/** The reset sequence — empty param restores the terminal's own default. */
export const POINTER_SHAPE_RESET = '\x1b]22;\x07'

/**
 * Emit the shape for the cell under the pointer — deduped (one write per
 * TRANSITION, not per motion event; a 1003 stream is chatty). The write sink
 * is injected so the renderer passes its own stdout and proofs pass a spy.
 */
export function applyPointerShape(
  selectable: boolean,
  write: (s: string) => void,
): void {
  if (!pointerShapeEnabled()) return
  const shape: PointerShape = selectable ? 'text' : 'default'
  if (shape === lastShape) return
  lastShape = shape
  write(pointerShapeSeq(shape))
}

/** Teardown: restore the terminal's default pointer + forget the latch (the
 *  next session must re-emit its first transition unconditionally). */
export function resetPointerShape(write: (s: string) => void): void {
  if (lastShape === null) return
  lastShape = null
  if (!pointerShapeEnabled()) return
  write(POINTER_SHAPE_RESET)
}

/** TEST-ONLY: clear the dedup latch. */
export function resetPointerShapeForTest(): void {
  lastShape = null
}
