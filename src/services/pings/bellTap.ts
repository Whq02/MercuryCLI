
const WINDOW_MS = 1000

let windowUntil = 0

export function tapTerminalBell(ring: () => void, nowMs: number = Date.now()): boolean {
  if (nowMs < windowUntil) return false
  windowUntil = nowMs + WINDOW_MS
  ring()
  return true
}

export function _resetBellTapForTesting(): void {
  windowUntil = 0
}
