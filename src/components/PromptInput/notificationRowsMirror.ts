// ============================================================================
//  notificationRowsMirror — the rendered height of the notice column, as a
//  process-visible fact.
//
//  The notice column paints a variable number of rows between the composer
//  and the footer: standing rows (the sign-in state, a provider steering
//  split at its seams), the transient, the token warning. A surface that
//  budgets rows BENEATH the column — the `?` shortcut grid caps itself to
//  the rows the terminal affords and says what it cut — cannot re-derive
//  that count without duplicating every row's condition, so the column
//  measures itself after each paint and publishes the height here.
//
//  One writer (the notice column), paint truth only: the value is the last
//  measured height, and a reader that mounts before the first publish sees
//  zero — the same as no column at all.
// ============================================================================

type Listener = () => void

let rows = 0
const listeners = new Set<Listener>()

/** Publish the column's measured height in rows. Equal values are silent. */
export function publishNotificationRows(next: number): void {
  const clamped = Number.isFinite(next) && next > 0 ? Math.floor(next) : 0
  if (clamped === rows) return
  rows = clamped
  for (const fn of [...listeners]) fn()
}

/** The last published height, in rows. */
export function getNotificationRows(): number {
  return rows
}

/** Subscribe to changes; returns the release. useSyncExternalStore-shaped. */
export function subscribeNotificationRows(fn: Listener): () => void {
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
  }
}

/** Test seam — the module holds process state by design. */
export function resetNotificationRowsForTesting(): void {
  rows = 0
  listeners.clear()
}
