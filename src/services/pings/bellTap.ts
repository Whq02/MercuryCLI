// ============================================================================
//  services/pings/bellTap — the ONE audible terminal-bell tap.
//
//  The pings rule: "taps arriving within a second ring once." Two
//  writers can reach the terminal bell for the same moment — the ping
//  engine (a new need or finished run) and the notifier's terminal_bell
//  floor (the host-signal sweep on terminals without native
//  notifications). Uncoalesced they beep twice for one event; every bell
//  writer therefore rings THROUGH this tap, and taps within the window
//  collapse into the first beep. The window is process-wide on purpose:
//  one operator, one terminal, one second.
// ============================================================================

const WINDOW_MS = 1000

let windowUntil = 0

/** Ring the bell unless a tap already rang within the window. Returns
 *  whether THIS call emitted the byte (a coalesced tap still counts as an
 *  audible cue — the beep it folded into is under a second old). */
export function tapTerminalBell(ring: () => void, nowMs: number = Date.now()): boolean {
  if (nowMs < windowUntil) return false
  windowUntil = nowMs + WINDOW_MS
  ring()
  return true
}

/** Proof seam — never product-read. */
export function _resetBellTapForTesting(): void {
  windowUntil = 0
}
