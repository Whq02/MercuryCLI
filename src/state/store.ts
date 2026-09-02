
export type Store<T> = {
  getState: () => T
  setState: (updater: (prevState: T) => T) => void
  subscribe: (listener: () => void) => () => void
}

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
