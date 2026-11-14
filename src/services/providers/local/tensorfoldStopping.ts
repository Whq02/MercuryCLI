type Listener = (port: number) => void

const listeners = new Set<Listener>()

export function onTensorFoldStopping(listener: Listener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function announceTensorFoldStopping(port: number): void {
  for (const listener of [...listeners]) {
    try {
      listener(port)
    } catch {
      void 0
    }
  }
}
