/**
 * A minimal listener-set primitive for stateless events. A signal is for
 * "this happened (with these arguments)"; a store is for "this is the value
 * now" — there is nothing to read back here and no latest state.
 */
export type Signal<Args extends unknown[] = []> = {
  subscribe: (listener: (...args: Args) => void) => () => void
  emit: (...args: Args) => void
  clear: () => void
}

export function createSignal<Args extends unknown[] = []>(): Signal<Args> {
  const listeners = new Set<(...args: Args) => void>()
  return {
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    emit(...args) {
      for (const listener of listeners) listener(...args)
    },
    clear() {
      listeners.clear()
    },
  }
}
