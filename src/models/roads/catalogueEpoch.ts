import { passedOver } from '../../platform/errors/passedOver.js'

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
    } catch (error) {
      passedOver(error)
    }
  }
}

export function subscribeCatalogueEpoch(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
