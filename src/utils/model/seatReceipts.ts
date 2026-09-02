// ============================================================================
//  seatReceipts — ONE receipt row per event that must reach the operator's
//  screen: a refused chat birth, an applied daemon change.
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

function emit(r: SeatReceipt): void {
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

/** Mint a receipt for a SYNCHRONOUS event. One row, immediately. */
export function mintImmediateReceipt(text: string, level: SeatReceipt['level'] = 'info'): void {
  emit({ text, level })
}

/** Test seam: clear the queue and the listeners. */
export function __resetSeatReceiptsForTests(): void {
  queue.length = 0
  listeners.clear()
}
