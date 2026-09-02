
export type SeatReceipt = {
  text: string
  level: 'info' | 'warning'
}

const RECEIPT_QUEUE_CAP = 20


const queue: SeatReceipt[] = []
const listeners = new Set<(r: SeatReceipt) => void>()
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

export function recentWarningReceipt(withinMs = 10_000): SeatReceipt | null {
  if (latestWarning === null || Date.now() - latestWarning.at > withinMs) return null
  return latestWarning.receipt
}

export function mintImmediateReceipt(text: string, level: SeatReceipt['level'] = 'info'): void {
  emit({ text, level })
}

export function __resetSeatReceiptsForTests(): void {
  queue.length = 0
  listeners.clear()
  latestWarning = null
}
