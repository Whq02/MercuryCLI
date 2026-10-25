
type CommandLifecycleState = 'started' | 'completed'
type CommandLifecycleListener = (commandUuid: string, state: CommandLifecycleState) => void

let primaryListener: CommandLifecycleListener | null = null

export function setCommandLifecycleListener(cb: CommandLifecycleListener | null): void {
  primaryListener = cb
}

export function notifyCommandLifecycle(uuid: string, state: CommandLifecycleState): void {
  primaryListener?.(uuid, state)
}
