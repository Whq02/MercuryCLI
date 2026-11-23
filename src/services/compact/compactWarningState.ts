let suppressed = false
const listeners = new Set<() => void>()

function notify(): void {
  for (const listener of listeners) {
    listener()
  }
}

export const compactWarningStore: {
  subscribe: (listener: () => void) => () => void
  getSnapshot: () => boolean
} = {
  subscribe(listener: () => void): () => void {
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  },
  getSnapshot(): boolean {
    return suppressed
  },
}

export function suppressCompactWarning(): void {
  if (suppressed) return
  suppressed = true
  notify()
}

export function clearCompactWarningSuppression(): void {
  if (!suppressed) return
  suppressed = false
  notify()
}
