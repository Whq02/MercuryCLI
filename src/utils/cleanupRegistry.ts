import { notBuilt } from '../pi/holes.js'

export function registerCleanup(fn: () => Promise<void>): () => void {
  return notBuilt('src/utils/cleanupRegistry.ts:5')
}

export async function runCleanupFunctions(): Promise<void> {
  return notBuilt('src/utils/cleanupRegistry.ts:12')
}
