// ============================================================================
//  changeTransaction/snapshotRing — the bounded anchored-snapshot ring that
//  feeds stale-anchor recovery.
//
//  Every anchor Mercury mints on a read (and every fresh anchor a patch
//  apply returns) can be remembered here WITH the exact text it was minted
//  from. When a later edit carries a STALE anchor, recovery looks the anchor
//  up: if the ring still holds its snapshot, the edit's spans can be
//  replayed against that snapshot and searched for a provably UNIQUE new
//  position in the current content (stalePatchRecovery.ts). No hit ⇒ the
//  existing typed staleness refusal — the ring only ever widens what can be
//  recovered, never what can be written.
//
//  Bounds: ENTRY_CAP anchors per owner, BYTES_CAP total, PER_ENTRY_BYTES per
//  snapshot; LRU eviction. Owner-scoped, conversation-lifetime.
// ============================================================================

import { registerOwnerScopedStore } from '../run/ownerLifecycle.js'
import type { OwnerKey } from '../run/ownerKey.js'
import { OwnerScopedStore } from '../run/ownerScopedStore.js'
import { mintFileAnchor, mintRangeAnchor, parseAnchor } from './snapshotAnchor.js'

export const SNAPSHOT_RING_BOUNDS = {
  entryCap: 24,
  bytesCap: 4 * 1024 * 1024,
  perEntryBytes: 1024 * 1024,
} as const

interface RingEntry {
  /** LF-normalized text the anchor was minted from. For a range anchor this
   *  is the WINDOW text; for a full anchor the whole file. */
  content: string
  path: string
  at: number
}

interface RingState {
  /** anchor string → snapshot. Insertion order is LRU order. */
  entries: Map<string, RingEntry>
}

const store = new OwnerScopedStore<RingState>({
  name: 'anchored-snapshots',
  create: () => ({ entries: new Map() }),
  cap: 32,
})
registerOwnerScopedStore(store)

function totalBytes(state: RingState): number {
  let n = 0
  for (const e of state.entries.values()) n += e.content.length
  return n
}

/** Remember the exact text an anchor was minted from. Oversized snapshots
 *  are skipped (recovery for them simply stays unavailable). */
export function rememberAnchoredSnapshot(
  owner: OwnerKey,
  anchor: string,
  content: string,
  path: string,
): void {
  if (content.length > SNAPSHOT_RING_BOUNDS.perEntryBytes) return
  const state = store.get(owner)
  state.entries.delete(anchor)
  state.entries.set(anchor, { content, path, at: Date.now() })
  while (
    state.entries.size > SNAPSHOT_RING_BOUNDS.entryCap ||
    totalBytes(state) > SNAPSHOT_RING_BOUNDS.bytesCap
  ) {
    const oldest = state.entries.keys().next().value as string | undefined
    if (oldest === undefined) break
    state.entries.delete(oldest)
  }
}

/**
 * Recall the snapshot an anchor was minted from — VERIFIED: the returned
 * text re-mints the same anchor (a corrupted or collided entry answers
 * undefined, never a wrong snapshot).
 */
export function recallAnchoredSnapshot(
  owner: OwnerKey,
  anchor: string,
): { content: string; path: string } | undefined {
  const entry = store.peek(owner)?.entries.get(anchor)
  if (!entry) return undefined
  // Verified recall: the stored text must re-mint the SAME anchor. A full
  // anchor digests the whole stored text; a range anchor digests the stored
  // WINDOW text under its own L<start>+<n> coordinates.
  const parsed = parseAnchor(anchor)
  if (!parsed) return undefined
  const reminted =
    parsed.kind === 'full'
      ? mintFileAnchor(entry.content)
      : mintRangeAnchor(entry.content, parsed.startLine, parsed.lineCount)
  if (reminted !== anchor) return undefined
  return { content: entry.content, path: entry.path }
}

/** TEST-ONLY: reset (proof harnesses). */
export function _resetSnapshotRingForTesting(): void {
  store.clearAllForShutdown()
}
