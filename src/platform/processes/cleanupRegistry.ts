import { afterMicrotask } from '../async/timers.js'

const cleanupFunctions = new Set<() => Promise<void>>()

export function registerCleanup(fn: () => Promise<void>): () => void {
  cleanupFunctions.add(fn)
  return () => {
    cleanupFunctions.delete(fn)
  }
}

export async function runCleanupFunctions(): Promise<void> {
  const outcomes = await Promise.allSettled([...cleanupFunctions].map(fn => afterMicrotask(fn)))
  for (const outcome of outcomes) {
    if (outcome.status === 'rejected') throw outcome.reason
  }
}
