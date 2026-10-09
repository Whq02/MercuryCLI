export type Signal<Args extends unknown[] = []> = {
  subscribe: (listener: (...args: Args) => void) => () => void
  emit: (...args: Args) => void
  clear: () => void
}

export function createSignal<Args extends unknown[] = []>(): Signal<Args> {
  type Listener = (...args: Args) => void
  const listeners = new Set<Listener>()
  const subscribe = (listener: Listener): (() => void) => {
    listeners.add(listener)
    return () => void listeners.delete(listener)
  }
  const emit = (...args: Args): void => listeners.forEach(listener => listener(...args))
  const clear = (): void => listeners.clear()
  return { subscribe, emit, clear }
}
