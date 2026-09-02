
type CommandLifecycleState = 'started' | 'completed'
type CommandLifecycleListener = (commandUuid: string, state: CommandLifecycleState) => void

let primaryListener: CommandLifecycleListener | null = null
const taps = new Set<CommandLifecycleListener>()

export function setCommandLifecycleListener(cb: CommandLifecycleListener | null): void {
  primaryListener = cb
}

export function addCommandLifecycleTap(cb: CommandLifecycleListener): () => void {
  taps.add(cb)
  return () => {
    taps.delete(cb)
  }
}

export function notifyCommandLifecycle(uuid: string, state: CommandLifecycleState): void {
  primaryListener?.(uuid, state)
  for (const tap of taps) {
    try {
      tap(uuid, state)
    } catch {
    }
  }
}
