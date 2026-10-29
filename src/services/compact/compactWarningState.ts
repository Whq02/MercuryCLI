
type Listener = () => void

let suppressed = false
const listeners = new Set<Listener>()

function emit(): void {
  for (const listener of listeners) listener()
}

export const compactWarningStore = {
  subscribe(listener: Listener): () => void {
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
  if (!suppressed) {
    suppressed = true
    emit()
  }
}

export function clearCompactWarningSuppression(): void {
  if (suppressed) {
    suppressed = false
    emit()
  }
}
