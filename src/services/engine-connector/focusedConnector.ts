import { logForDebugging } from '../../utils/debug.js'
import { noSessionConnector } from './noSessionConnector.js'
import type { EngineConnectorV1 } from './types.js'

let focused: EngineConnectorV1 | null = null

let hopEpoch = 0
export function claimHopEpoch(): number {
  hopEpoch += 1
  return hopEpoch
}
export function hopEpochIsCurrent(epoch: number): boolean {
  return epoch === hopEpoch
}
const listeners = new Set<() => void>()

function emit(): void {
  for (const l of listeners) {
    try {
      l()
    } catch (e) {
      logForDebugging(
        `[engine-connector] focused listener threw (ignored): ${e}`,
      )
    }
  }
}

export function getFocusedSessionConnector(): EngineConnectorV1 {
  return focused ?? noSessionConnector()
}

export function hasFocusedSession(): boolean {
  return focused !== null
}

export function setFocusedSessionConnector(next: EngineConnectorV1): void {
  const before = getFocusedSessionConnector()
  focused = next
  if (getFocusedSessionConnector() === before) return
  emit()
}

export function releaseFocusedSessionConnector(): void {
  claimHopEpoch()
  if (focused === null) return
  focused = null
  emit()
}

export function subscribeFocusedSessionConnector(
  listener: () => void,
): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function emitFocusedSessionConnectorChanged(): void {
  emit()
}

let landings = 0
export function landingInFlight(): boolean {
  return landings > 0
}
export async function withLanding<T>(landing: Promise<T>): Promise<T> {
  landings += 1
  emit()
  try {
    return await landing
  } finally {
    landings -= 1
    emit()
  }
}

export function subscribeThroughFocused(
  attach: (connector: EngineConnectorV1, listener: () => void) => () => void,
): (listener: () => void) => () => void {
  return listener => {
    let inner = attach(getFocusedSessionConnector(), listener)
    const outer = subscribeFocusedSessionConnector(() => {
      inner()
      inner = attach(getFocusedSessionConnector(), listener)
      listener()
    })
    return () => {
      outer()
      inner()
    }
  }
}

export function _resetFocusedSessionConnectorForTesting(): void {
  focused = null
  landings = 0
  emit()
}
