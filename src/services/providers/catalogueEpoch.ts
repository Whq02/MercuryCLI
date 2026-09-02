
let epoch = 0
const listeners = new Set<() => void>()

export function catalogueEpoch(): number {
  return epoch
}

export function bumpCatalogueEpoch(): void {
  epoch += 1
  for (const listener of [...listeners]) {
    try {
      listener()
    } catch {
    }
  }
}

export function subscribeCatalogueEpoch(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
