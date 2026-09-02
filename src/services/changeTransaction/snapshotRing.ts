
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
  content: string
  path: string
  at: number
}

interface RingState {
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

export function recallAnchoredSnapshot(
  owner: OwnerKey,
  anchor: string,
): { content: string; path: string } | undefined {
  const entry = store.peek(owner)?.entries.get(anchor)
  if (!entry) return undefined
  const parsed = parseAnchor(anchor)
  if (!parsed) return undefined
  const reminted =
    parsed.kind === 'full'
      ? mintFileAnchor(entry.content)
      : mintRangeAnchor(entry.content, parsed.startLine, parsed.lineCount)
  if (reminted !== anchor) return undefined
  return { content: entry.content, path: entry.path }
}

export function _resetSnapshotRingForTesting(): void {
  store.clearAllForShutdown()
}
