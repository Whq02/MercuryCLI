// ============================================================================
//  utils/cockpit/pointerCell — the terminal pointer's last-known CELL, as a
//  tiny import-free pub/sub store.
//
//  Written by the ONE mouse decode path (ink App.handleMouseEvent — every SGR
//  press/drag/motion event carries a position; mode 1003 any-motion streams on
//  macOS/Linux, so hover alone feeds this). Read by presence-flavored chrome —
//  today the critter hero's mouse-tracking gaze (critterGaze.ts).
//
//  DELIBERATELY a leaf: zero imports, so the vendored ink layer can tap it
//  without acquiring an edge into utils/config (the gate lives in
//  critterGaze.ts, view-side). /mouse off ⇒ handleMouseEvent returns before
//  the tap ⇒ this store simply never updates — the natural off-state.
//
//  Notify discipline: subscribers fire only on CELL edges (the decode path
//  already dedupes motion, but press/release re-report the same cell — the
//  store dedupes again so a click never causes a spurious re-render), plus
//  one IDLE RESET ~6s after the last movement so anything gazing at the
//  pointer drifts back to its authored rest pose instead of staring at a
//  stale coordinate forever. The timer is unref'd — it must never hold the
//  process open.
// ============================================================================

export type PointerCell = { col: number; row: number }

/** Pointer-idle window before the cell resets to null (gaze returns home). */
export const POINTER_IDLE_RESET_MS = 6000

let cell: PointerCell | null = null
let version = 0
const listeners = new Set<() => void>()
let idleTimer: ReturnType<typeof setTimeout> | null = null

function notify(): void {
  version++
  for (const l of listeners) l()
}

function armIdleReset(): void {
  if (idleTimer) clearTimeout(idleTimer)
  idleTimer = setTimeout(() => {
    idleTimer = null
    if (cell !== null) {
      cell = null
      notify()
    }
  }, POINTER_IDLE_RESET_MS)
  // Never keep the process alive for a cosmetic reset.
  idleTimer.unref?.()
}

/** Record the pointer's screen cell (0-based). Dedupes same-cell reports.
 *  The idle-reset timer is SUBSCRIBER-COUNTED: with nobody
 *  gazing, every mouse motion would otherwise clear+re-arm a 6s timeout for an event
 *  no one would ever see — the cell still updates (cheap assignment), and the
 *  first subscriber arms the countdown for whatever cell is standing. */
export function setPointerCell(col: number, row: number): void {
  if (!Number.isFinite(col) || !Number.isFinite(row)) return
  if (listeners.size > 0) armIdleReset()
  if (cell && cell.col === col && cell.row === row) return
  cell = { col, row }
  notify()
}

/** Explicit reset (tests; a surface that wants gaze-home on its own cue). */
export function clearPointerCell(): void {
  if (idleTimer) {
    clearTimeout(idleTimer)
    idleTimer = null
  }
  if (cell !== null) {
    cell = null
    notify()
  }
}

export function getPointerCell(): PointerCell | null {
  return cell
}

/** Primitive snapshot for useSyncExternalStore ("col,row" | ""). */
export function getPointerCellKey(): string {
  return cell ? `${cell.col},${cell.row}` : ''
}

export function getPointerVersion(): number {
  return version
}

export function subscribePointerCell(listener: () => void): () => void {
  listeners.add(listener)
  // A cell recorded while nobody was watching starts its idle countdown NOW —
  // otherwise the first gaze mount could stare at a minutes-old coordinate
  // with no reset ever pending.
  if (listeners.size === 1 && cell !== null && idleTimer === null) armIdleReset()
  return () => {
    listeners.delete(listener)
    // Last watcher gone: drop the pending reset too — nothing reads the
    // outcome, and the next subscriber re-arms it above.
    if (listeners.size === 0 && idleTimer !== null) {
      clearTimeout(idleTimer)
      idleTimer = null
    }
  }
}
