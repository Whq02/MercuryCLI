
export const BURST_WINDOW_MS = 24

const listeners = new Set<(kind: string | null) => void>()

export function notifyRoomStatusFeed(kind?: string): void {
  for (const l of [...listeners]) {
    try {
      l(kind ?? null)
    } catch {
    }
  }
}

export function subscribeRoomStatusFeed(cb: (kind: string | null) => void): () => void {
  listeners.add(cb)
  return () => {
    listeners.delete(cb)
  }
}

export function _roomStatusFeedListenerCountForTesting(): number {
  return listeners.size
}
