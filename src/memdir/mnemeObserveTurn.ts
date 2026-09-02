
import { basename } from 'node:path'
import { flagEnabled } from '../substrate/flagRegistry.js'
import { subscribeToolTerminal } from '../services/run/effectObserver.js'
import { appendObservation } from './mnemeBuffer.js'
import { mnemeEnabled } from './mnemeGates.js'

export function mnemeObserveEnabled(): boolean {
  return mnemeEnabled() && flagEnabled('MERCURY_MEMORY_OBSERVE')
}

const MAX_FACTS_PER_TURN = 10
let armed = false
const pendingByOwner = new Map<string, string[]>()

export function _resetTurnObservationForTesting(): void {
  pendingByOwner.clear()
}

export function armMnemeTurnObservation(): void {
  if (armed || !mnemeObserveEnabled()) return
  armed = true
  subscribeToolTerminal(event => {
    try {
      if (!mnemeObserveEnabled()) return
      const effect = event.effect
      if (!event.ok || !effect || effect.outcome !== 'succeeded' || effect.changedPaths.length === 0) {
        return
      }
      const owner = String(event.owner)
      const list = pendingByOwner.get(owner) ?? []
      if (list.length >= MAX_FACTS_PER_TURN) return
      const first = basename(effect.changedPaths[0] ?? '')
      const rest = effect.changedPaths.length > 1 ? ` +${effect.changedPaths.length - 1}` : ''
      list.push(`${effect.operation} ${first}${rest}`)
      pendingByOwner.set(owner, list)
    } catch {
    }
  })
}

export function flushMnemeTurnObservation(owner: string): boolean {
  armMnemeTurnObservation()
  const list = pendingByOwner.get(owner)
  pendingByOwner.delete(owner)
  if (!mnemeObserveEnabled() || !list || list.length === 0) return false
  return appendObservation({
    text: `turn outcome: ${list.join('; ')}`,
    source: 'turn-end',
    topicHint: 'session-work',
  })
}
