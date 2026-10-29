type SeatReceipt = {
  text: string
  level: 'info' | 'warning'
}

const RECEIPT_QUEUE_CAP = 20

const queue: SeatReceipt[] = []
type Listener = { cb: (r: SeatReceipt) => void; takes: (r: SeatReceipt) => boolean }
const listeners = new Set<Listener>()

let latestWarning: { receipt: SeatReceipt; at: number } | null = null

function deliver(r: SeatReceipt): boolean {
  const takers = [...listeners].filter(l => l.takes(r))
  for (const l of takers) l.cb(r)
  return takers.length > 0
}

function emit(r: SeatReceipt): void {
  if (r.level === 'warning') latestWarning = { receipt: r, at: Date.now() }
  if (deliver(r)) return
  queue.push(r)
  if (queue.length > RECEIPT_QUEUE_CAP) queue.shift()
}

export function subscribeSeatReceipts(cb: (r: SeatReceipt) => void, takes: (r: SeatReceipt) => boolean = () => true): () => void {
  const listener: Listener = { cb, takes }
  listeners.add(listener)
  const kept: SeatReceipt[] = []
  for (const r of queue.splice(0)) if (!deliver(r)) kept.push(r)
  queue.push(...kept)
  return () => {
    listeners.delete(listener)
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
