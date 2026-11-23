import { dirname } from 'path'

type TranscriptStoreHealth = { failing: boolean; sentence: string | null }
let storeHealth: TranscriptStoreHealth = { failing: false, sentence: null }
const storeHealthListeners = new Set<() => void>()
export function setStoreHealth(next: TranscriptStoreHealth): void {
  if (storeHealth.failing === next.failing && storeHealth.sentence === next.sentence) return
  storeHealth = next
  for (const listener of storeHealthListeners) listener()
}
export function transcriptStoreHealth(): TranscriptStoreHealth {
  return storeHealth
}
export function subscribeTranscriptStoreHealth(listener: () => void): () => void {
  storeHealthListeners.add(listener)
  return () => storeHealthListeners.delete(listener)
}

export function describeTranscriptStoreFailure(filePath: string, error: unknown): Error {
  const raw = error instanceof Error ? error.message : String(error)
  return new Error(
    `the session transcript store is unwritable (${dirname(filePath)}): ${raw}. ` +
      `Repair the directory, or run with --ephemeral to skip transcripts for this run.`,
    { cause: error },
  )
}
