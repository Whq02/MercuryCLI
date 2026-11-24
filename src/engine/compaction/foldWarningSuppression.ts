let suppressed = false
const listeners = new Set<() => void>()

function notify(): void {
  for (const listener of listeners) {
    listener()
  }
}

export const foldWarningStore: {
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

export function suppressFoldWarning(): void {
  if (suppressed) return
  suppressed = true
  notify()
}

export function clearFoldWarningSuppression(): void {
  if (!suppressed) return
  suppressed = false
  notify()
}
