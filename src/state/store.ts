// ============================================================================
//  src/state/store.ts — a generic, framework-free external store.
// ============================================================================

export type Store<T> = {
  getState: () => T
  setState: (updater: (prevState: T) => T) => void
  /** Returns the unsubscribe function. */
  subscribe: (listener: () => void) => () => void
}

/**
 * IDENTITY SHORT-CIRCUIT: an updater returning the SAME REFERENCE performs
 * no assignment, no change callback, and no listener notification — every
 * "no-op guard" in callers relies on this; violating it causes render
 * storms and spurious persistence writes.
 *
 * On a real change: assign, then the change callback (new, old), THEN the
 * listeners. Listeners receive no arguments and pull state themselves.
 * The listener collection is a Set, so unsubscribing during notification
 * cannot skip other listeners.
 */
export function createStore<T>(
  initialState: T,
  onChange?: (change: { newState: T; oldState: T }) => void,
): Store<T> {
  let state = initialState
  const listeners = new Set<() => void>()
  return {
    getState: () => state,
    setState: (updater: (prevState: T) => T): void => {
      const next = updater(state)
      if (next === state) return
      const previous = state
      state = next
      onChange?.({ newState: next, oldState: previous })
      for (const listener of listeners) listener()
    },
    subscribe: (listener: () => void): (() => void) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
}
