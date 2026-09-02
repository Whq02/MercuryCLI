
type Listener = () => void

let rows = 0
const listeners = new Set<Listener>()

export function publishNotificationRows(next: number): void {
  const clamped = Number.isFinite(next) && next > 0 ? Math.floor(next) : 0
  if (clamped === rows) return
  rows = clamped
  for (const fn of [...listeners]) fn()
}

export function getNotificationRows(): number {
  return rows
}

export function subscribeNotificationRows(fn: Listener): () => void {
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
  }
}

export function resetNotificationRowsForTesting(): void {
  rows = 0
  listeners.clear()
}
