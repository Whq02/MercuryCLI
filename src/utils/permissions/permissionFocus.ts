// ============================================================================
//  permissions/permissionFocus — the modal permission-card presence fact and
//  the gesture-refusal owner.
//
//  THE RULE (operator live-drive, block E): an open permission card — an
//  interview question above all — is THE focus. A pointer/gesture that would
//  open or queue ANOTHER surface (a rail command row, a deck row, a session
//  tab, a prompt prefill) is REFUSED while a card is mounted, with a visible
//  notice — never silently parked to pop after the card resolves (the
//  queued-overlay class: the parked surface popped after the question and
//  the next esc killed both).
//
//  Shape: the composerSeed module-store pattern — a counted arm paired with
//  the card's mount (queued cards can overlap), and a notifier the REPL
//  registers once (the notification queue lives in AppState; this seam is
//  how a module store reaches it). Gesture WRITERS (helmFocus's activation /
//  command-dispatch / prefill channels) consult refuseGestureWhileModal at
//  the moment of the gesture — the refusal happens where the gesture enters,
//  because the drain side (PromptInput) is unmounted exactly while a card
//  holds the frame, and a parked write would outlive the card.
// ============================================================================

let mounted = 0
let notifier: ((text: string) => void) | null = null

/** REPL registers its notification appender (one per REPL mount). */
export function registerPermissionFocusNotifier(
  fn: (text: string) => void,
): () => void {
  notifier = fn
  return () => {
    if (notifier === fn) notifier = null
  }
}

/** A permission card arms the presence for its mounted lifetime. Counted;
 *  the disarm is idempotent (StrictMode double-invoked effects). */
export function armPermissionFocus(): () => void {
  mounted++
  let released = false
  return () => {
    if (released) return
    released = true
    mounted = Math.max(0, mounted - 1)
  }
}

/** True while any modal permission card is mounted. */
export function isPermissionFocusActive(): boolean {
  return mounted > 0
}

/** The one refusal verdict: true = a card is up, the gesture must be
 *  DROPPED (the caller writes nothing), and the operator has been told why.
 *  `what` names the refused surface for the notice ('/usage', 'prefill'…). */
export function refuseGestureWhileModal(what: string): boolean {
  if (mounted <= 0) return false
  notifier?.(
    `${what} waits — answer the open question first (esc dismisses it)`,
  )
  return true
}

/** Test seam. */
export function __permissionFocusResetForTest(): void {
  mounted = 0
  notifier = null
}
