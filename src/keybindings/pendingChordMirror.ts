// ============================================================================
//  pendingChordMirror — the process-visible pending-chord fact.
//
//  The chord machinery is per-provider state, and the provider that owns a
//  given keystroke is decided by LISTENER ORDER: the parked REPL world's
//  ChordInterceptor (mounted at boot, registered first, no covered gate)
//  consumes every chord prefix even while a route surface covers it — the
//  covering surface's own provider never sees the arm. A surface that must
//  PAINT against the pending chord (the Concourse close chord's confirm
//  hint) therefore cannot read its own context; it reads this mirror.
//
//  One writer class: every KeybindingSetup writes its pending state here at
//  every transition (arm, resolve, cancel, timeout). Only one interceptor
//  ever consumes a given keystroke (stopImmediatePropagation between
//  listeners), so writes never interleave within one chord. The mirror is
//  paint truth only — no key routing may read it (the resolver's own state
//  stays the one routing authority).
// ============================================================================

import type { ParsedKeystroke } from './types.js'

type Listener = () => void

let pending: ParsedKeystroke[] | null = null
const listeners = new Set<Listener>()

/** Publish a provider's pending-chord transition. Null = no chord open. */
export function publishPendingChord(next: ParsedKeystroke[] | null): void {
  if (pending === next) return
  pending = next
  for (const fn of [...listeners]) fn()
}

/** The pending chord as last published, or null. Paint truth only. */
export function getPendingChordMirror(): ParsedKeystroke[] | null {
  return pending
}

/** Subscribe to transitions; returns the release. useSyncExternalStore-shaped. */
export function subscribePendingChordMirror(fn: Listener): () => void {
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
  }
}

/** Test seam — the module holds process state by design. */
export function resetPendingChordMirrorForTesting(): void {
  pending = null
  listeners.clear()
}
