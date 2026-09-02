// ============================================================================
//  pendingActivation — the VISIBLE process's
//  memory of the LAST host-emitted deep link.
//
// Platform reality (recorded): no terminal notification carries a
//  click callback — "activation" is the operator RETURNING to the app. So
//  activation honesty means: when they return, the surface is already
//  pointing at the exact session/obligation the toast named — the rail
//  preseeds its selection here and the default region already lands on the
//  rail. Focus is never stolen: preselection paints, the operator presses
//  ↵. In-process ephemeral state (useSyncExternalStore — the sessionAccent
//  pattern): a restart clears it, which is honest — the durable obligation
//  rows are the source of truth; this is only the "which one did the toast
//  mean" pointer.
// ============================================================================
import type { SignalTarget } from '../notificationPolicy.js'

type Listener = () => void

let pending: SignalTarget | null = null
const listeners = new Set<Listener>()

/** Record the deep link of a host-EMITTED signal (the hooks call this on
 *  emitted:true only — a suppressed/deduped signal never re-points). */
export function notePendingActivation(target: SignalTarget | undefined): void {
  if (!target || (target.obligationId === undefined && target.sessionId === undefined)) return
  pending = target
  for (const l of listeners) l()
}

export function readPendingActivation(): SignalTarget | null {
  return pending
}

/** Consume-on-use: the surface that acted on the pointer clears it so a
 *  later visit does not re-preselect a stale target. */
export function clearPendingActivation(): void {
  pending = null
  for (const l of listeners) l()
}

export function subscribePendingActivation(cb: Listener): () => void {
  listeners.add(cb)
  return () => {
    listeners.delete(cb)
  }
}

/** Proof seam. */
export function _resetPendingActivationForTesting(): void {
  pending = null
  listeners.clear()
}
