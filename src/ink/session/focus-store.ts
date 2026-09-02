// ============================================================================
//  focus-store — the terminal focus signal.
//
//  RESPONSIBILITY: the one process-wide record of DECSET 1004 focus truth.
//  'unknown' (no event yet / unsupported terminal) reads as FOCUSED — a
//  terminal that never reports focus must never be throttled. Subscribers
//  are notified synchronously on every set (useSyncExternalStore snapshots
//  re-read cheaply; the store does not dedup — characterized and pinned).
//
//  CONTRACT: the FOCUS-STORE law in prove-session-contract.ts. The historical
//  body carried a blur-resolver set with no producer — dead residue, dropped.
// ============================================================================

export type TerminalFocusState = 'focused' | 'blurred' | 'unknown'

let state: TerminalFocusState = 'unknown'
const subscribers = new Set<() => void>()

function notify(): void {
  for (const cb of subscribers) cb()
}

export function setTerminalFocused(v: boolean): void {
  state = v ? 'focused' : 'blurred'
  notify()
}

/** unknown ≡ focused: only an explicit blur reads false. */
export function getTerminalFocused(): boolean {
  return state !== 'blurred'
}

export function getTerminalFocusState(): TerminalFocusState {
  return state
}

/** useSyncExternalStore subscription contract. */
export function subscribeTerminalFocus(cb: () => void): () => void {
  subscribers.add(cb)
  return () => {
    subscribers.delete(cb)
  }
}

export function resetTerminalFocusState(): void {
  state = 'unknown'
  notify()
}
