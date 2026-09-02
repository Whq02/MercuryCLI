import type { SignalTarget } from '../notificationPolicy.js'

type Listener = () => void

let pending: SignalTarget | null = null
const listeners = new Set<Listener>()

export function notePendingActivation(target: SignalTarget | undefined): void {
  if (!target || (target.obligationId === undefined && target.sessionId === undefined)) return
  pending = target
  for (const l of listeners) l()
}

export function readPendingActivation(): SignalTarget | null {
  return pending
}

export function clearPendingActivation(): void {
  pending = null
  for (const l of listeners) l()
}

export function subscribePendingActivation(cb: Listener): () => void {
  listeners.add(cb)
  return () => {
    listeners.delete(cb)
  }
}

export function _resetPendingActivationForTesting(): void {
  pending = null
  listeners.clear()
}
