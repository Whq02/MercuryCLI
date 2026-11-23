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
    setState: updater => {
      const oldState = state
      const newState = updater(oldState)
      if (newState === oldState) return
      state = newState
      onChange?.({ newState, oldState })
      for (const listener of listeners) {
        listener()
      }
    },
    subscribe: listener => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
}
