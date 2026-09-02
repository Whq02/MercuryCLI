/**
 * Command started/completed notification, keyed by command UUID.
 *
 * Exactly one primary listener slot exists (the SDK/bridge path sets,
 * replaces or clears it). Any number of additive taps may also be
 * registered; taps never steal the primary slot.
 */

type CommandLifecycleState = 'started' | 'completed'
type CommandLifecycleListener = (commandUuid: string, state: CommandLifecycleState) => void

let primaryListener: CommandLifecycleListener | null = null
const taps = new Set<CommandLifecycleListener>()

/** Set, replace or clear the single primary listener. */
export function setCommandLifecycleListener(cb: CommandLifecycleListener | null): void {
  primaryListener = cb
}

/**
 * Register an additive tap. The tap collection is a set keyed by function
 * identity: registering the same reference twice yields one entry (one call
 * per notification), and removing once removes it.
 */
export function addCommandLifecycleTap(cb: CommandLifecycleListener): () => void {
  taps.add(cb)
  return () => {
    taps.delete(cb)
  }
}

/**
 * Notify the primary listener first, then every tap in registration order.
 * A throwing tap is swallowed so it can never break the notification path;
 * a throwing primary propagates.
 */
export function notifyCommandLifecycle(uuid: string, state: CommandLifecycleState): void {
  primaryListener?.(uuid, state)
  for (const tap of taps) {
    try {
      tap(uuid, state)
    } catch {
      // Taps are additive observers; their failures must not break the path.
    }
  }
}
