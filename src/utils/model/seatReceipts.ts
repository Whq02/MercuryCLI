// ============================================================================
//  seatReceipts — ONE receipt row per event that must reach the operator's
//  screen: a refused chat birth, an applied daemon change, a persisted value
//  this build no longer knows.
//
//  The mint is synchronous and the row is informational: the REPL hook
//  (useSeatReceipts) subscribes and appends each receipt as one system row;
//  receipts minted before the hook mounts queue (bounded) and drain on
//  subscribe, in order.
// ============================================================================

export type SeatReceipt = {
  text: string
  level: 'info' | 'warning'
}

const RECEIPT_QUEUE_CAP = 20

// ── queue + emission ─────────────────────────────────────────────────────────

const queue: SeatReceipt[] = []
const listeners = new Set<(r: SeatReceipt) => void>()
/** The latest WARNING minted, with its time — for a screen that mounts
 *  AFTER the mint (the boot face taking the frame back from a refused
 *  birth while a chat's subscription drained the row). */
let latestWarning: { receipt: SeatReceipt; at: number } | null = null

function emit(r: SeatReceipt): void {
  if (r.level === 'warning') latestWarning = { receipt: r, at: Date.now() }
  if (listeners.size === 0) {
    queue.push(r)
    if (queue.length > RECEIPT_QUEUE_CAP) queue.shift()
    return
  }
  for (const l of listeners) l(r)
}

/** Subscribe the transcript emitter (the REPL hook). Queued receipts drain
 *  immediately, in order. Returns the unsubscribe. */
export function subscribeSeatReceipts(cb: (r: SeatReceipt) => void): () => void {
  listeners.add(cb)
  while (queue.length > 0) {
    const r = queue.shift()!
    for (const l of listeners) l(r)
  }
  return () => {
    listeners.delete(cb)
  }
}

/** The most recent WARNING receipt minted within `withinMs` (null when none
 *  or older): a screen mounting after the mint reads the row it was handed
 *  back with — the live subscription carries everything later. */
export function recentWarningReceipt(withinMs = 10_000): SeatReceipt | null {
  if (latestWarning === null || Date.now() - latestWarning.at > withinMs) return null
  return latestWarning.receipt
}

/** Mint a receipt for a SYNCHRONOUS event. One row, immediately. */
export function mintImmediateReceipt(text: string, level: SeatReceipt['level'] = 'info'): void {
  emit({ text, level })
}

/** Test seam: clear the queue and the listeners. */
export function __resetSeatReceiptsForTests(): void {
  queue.length = 0
  listeners.clear()
  latestWarning = null
}
