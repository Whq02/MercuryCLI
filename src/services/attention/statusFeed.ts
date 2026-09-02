// ============================================================================
//  statusFeed — the room/link status CHANGE FEED.
//
//  The statusbar chip would otherwise poll cachedRoomSnapshot()+remoteLinkStatus()
//  every 1.5 s to notice a beacon, a decided ticket, a helm move or a dead
//  wire. Every one of those facts already ARRIVES as an event — a room frame
//  on the subscription, a status transition on the remote client — so this
//  module is nothing but the missing fan-out: producers ping it at their
//  existing event seams, consumers ride useSyncExternalStore over a compact
//  signature and re-render only on real transitions. Zero timers here; the
//  one time-shaped fact (a typing beacon's TTL decay) is armed by the
//  consumer ONLY while a typing entry is live.
// ============================================================================

/** Trailing-window width for burst-kind notifications (mandate 6: at most
 *  one render per burst window; tuned against render captures). Lives with
 *  the feed both burst consumers coalesce over (the federation view and the
 *  attention view model). */
export const BURST_WINDOW_MS = 24

const listeners = new Set<(kind: string | null) => void>()

/**
 * Producer ping — called at the owning event seams (room frame delivered,
 * subscription created/replaced, remote link status transition). Cheap and
 * reentrant-safe; consumers re-read their snapshot lazily.
 *
 * `kind` classifies the transition for consumers that window their
 * renders: a frame producer passes the frame kind, the link seam passes
 * 'link', and an unclassified ping omits it — federationView treats null as
 * immediate (conservative). Zero-arg listeners are unaffected.
 */
export function notifyRoomStatusFeed(kind?: string): void {
  for (const l of [...listeners]) {
    try {
      l(kind ?? null)
    } catch {
      // display-only consumers; a throwing listener must not break delivery
    }
  }
}

export function subscribeRoomStatusFeed(cb: (kind: string | null) => void): () => void {
  listeners.add(cb)
  return () => {
    listeners.delete(cb)
  }
}

/** Test seam: observable listener count (never used by product code). */
export function _roomStatusFeedListenerCountForTesting(): number {
  return listeners.size
}
