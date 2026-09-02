// ============================================================================
//  utils/cockpit/typingActivity — the DECOR-tier typing pause (
//  COCKPIT S2).
//
//  A tiny module store: the composer's input-change path calls
//  markTypingActivity() per keystroke; decoration primitives (ReadyBreath ·
//  TwinkleSpark — the DECOR tier in liveGlyphs.ts) subscribe and PAUSE while
//  the operator is typing, resuming TYPING_HOLD_MS after the last keystroke.
//  While you type, your own words are the only motion on screen.
//
//  Shape rules (the keybinding-gotchas lesson): module state consumed by
//  React MUST go through useSyncExternalStore — the hook lives in
//  src/hooks/useTypingPause.ts. The snapshot is a stored BOOLEAN flipped by
//  events + one trailing timer (never a Date.now() read in getSnapshot —
//  time-derived snapshots tear).
//
//  TRUTH-tier indicators (WorkingGlyph, tool-mark breath, AttentionPulse)
//  deliberately do NOT consult this store: never pause truth, always pause
//  decoration.
// ============================================================================

/** How long decoration stays paused after the last keystroke. Long enough
 *  that steady typing never flickers decoration back on between words;
 *  short enough that rest reads as rest. */
export const TYPING_HOLD_MS = 1400

let typingActive = false
let holdTimer: ReturnType<typeof setTimeout> | null = null
const subscribers = new Set<() => void>()

function notify(): void {
  for (const fn of subscribers) fn()
}

/** The composer input-change path calls this per keystroke (one chokepoint:
 *  REPL's onInputChange). Cheap: a timer re-arm + at most one notify per
 *  false→true edge. */
export function markTypingActivity(): void {
  if (holdTimer) clearTimeout(holdTimer)
  holdTimer = setTimeout(() => {
    holdTimer = null
    if (typingActive) {
      typingActive = false
      notify()
    }
  }, TYPING_HOLD_MS)
  holdTimer.unref?.()
  if (!typingActive) {
    typingActive = true
    notify()
  }
}

/** Snapshot for useSyncExternalStore — a stored boolean, never time-derived. */
export function isTypingActive(): boolean {
  return typingActive
}

export function subscribeTypingActivity(fn: () => void): () => void {
  subscribers.add(fn)
  return () => subscribers.delete(fn)
}

/** Test seam: reset the store between proof cases. */
export function __typingActivityResetForTest(): void {
  if (holdTimer) clearTimeout(holdTimer)
  holdTimer = null
  typingActive = false
}
