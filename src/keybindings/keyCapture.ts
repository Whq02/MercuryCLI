// ============================================================================
//  keyCapture — the one-slot claim on raw keystroke delivery.
//
//  `/keys` answers "what does this chord do here?" by running the operator's
//  actual keystroke through the resolver. It cannot do that while the runtime
//  is still ACTING on those keystrokes: ChordInterceptor registers its input
//  listener before every other handler, so `ctrl+x` would open a chord and
//  `ctrl+t` would toggle the task panel before the panel ever saw them.
//
//  So a surface that is READING keys rather than obeying them claims this
//  slot, and the interceptor hands it the raw pair and stops there. One slot,
//  no stack: exactly one surface can be recording a chord at a time, and the
//  claim is released by React's own unmount cleanup — a panel that dies with
//  the claim held cannot leave the keyboard dead.
//
//  Escape is delivered like any other key so the claiming surface can leave
//  capture; every capture surface must treat it as the exit.
// ============================================================================

import type { Key } from '../ink.js'

export type KeyCaptureFn = (input: string, key: Key) => void

let capture: KeyCaptureFn | null = null

/** Claim raw delivery. Returns the release; call it from effect cleanup. */
export function claimKeyCapture(fn: KeyCaptureFn): () => void {
  capture = fn
  return () => {
    if (capture === fn) capture = null
  }
}

/** The current claim, or null when the runtime owns the keyboard normally. */
export function currentKeyCapture(): KeyCaptureFn | null {
  return capture
}

/** Test seam — the module holds process state by design. */
export function resetKeyCaptureForTesting(): void {
  capture = null
}
