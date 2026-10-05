export type TranscriptAnchor = { uuid: string; idx: number } | null

export type TranscriptMemoryV1 = {
  expanded: ReadonlySet<string>
  anchor: { current: TranscriptAnchor }
}

const VIEWS_KEPT = 64
const NO_ROWS: ReadonlySet<string> = new Set<string>()
const memories = new Map<string, TranscriptMemoryV1>()
const listeners = new Map<string, Set<() => void>>()

export function transcriptMemoryOf(view: string): TranscriptMemoryV1 {
  const known = memories.get(view)
  if (known !== undefined) return known
  if (memories.size >= VIEWS_KEPT) {
    const oldest = memories.keys().next().value
    if (oldest !== undefined) memories.delete(oldest)
  }
  const fresh: TranscriptMemoryV1 = { expanded: NO_ROWS, anchor: { current: null } }
  memories.set(view, fresh)
  return fresh
}

export function expandedRowsOf(view: string): ReadonlySet<string> {
  return transcriptMemoryOf(view).expanded
}

export function toggleExpandedRow(view: string, key: string): void {
  const memory = transcriptMemoryOf(view)
  const next = new Set(memory.expanded)
  if (next.has(key)) next.delete(key)
  else next.add(key)
  memory.expanded = next
  for (const listener of listeners.get(view) ?? []) listener()
}

export function subscribeExpandedRows(view: string, listener: () => void): () => void {
  let set = listeners.get(view)
  if (set === undefined) {
    set = new Set()
    listeners.set(view, set)
  }
  set.add(listener)
  return () => {
    set.delete(listener)
    if (set.size === 0) listeners.delete(view)
  }
}

export function _resetTranscriptMemoryForTesting(): void {
  memories.clear()
  listeners.clear()
}
