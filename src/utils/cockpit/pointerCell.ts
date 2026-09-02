
export type PointerCell = { col: number; row: number }

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
  idleTimer.unref?.()
}

export function setPointerCell(col: number, row: number): void {
  if (!Number.isFinite(col) || !Number.isFinite(row)) return
  if (listeners.size > 0) armIdleReset()
  if (cell && cell.col === col && cell.row === row) return
  cell = { col, row }
  notify()
}

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

export function getPointerCellKey(): string {
  return cell ? `${cell.col},${cell.row}` : ''
}

export function getPointerVersion(): number {
  return version
}

export function subscribePointerCell(listener: () => void): () => void {
  listeners.add(listener)
  if (listeners.size === 1 && cell !== null && idleTimer === null) armIdleReset()
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0 && idleTimer !== null) {
      clearTimeout(idleTimer)
      idleTimer = null
    }
  }
}
