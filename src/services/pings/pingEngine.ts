
import type { AttentionState } from '../../services/attention/contracts.js'
import { bucketItems } from '../../services/attention/contracts.js'

export interface PingViewSlice {
  needsYou: ReadonlyArray<{ subjectId: string; atMs: number }>
  finishedRuns: ReadonlyArray<{ subjectId: string; sourceEventId: string; atMs: number }>
}

export function pingSliceOf(state: AttentionState): PingViewSlice {
  return {
    needsYou: bucketItems(state, 'needs-you'),
    finishedRuns: bucketItems(state, 'completed').filter(
      i => i.reasonCode === 'run-completed',
    ),
  }
}

export interface PingEngineDeps {
  ringBell: () => void
  bellEnabled: () => boolean
  nowMs?: () => number
  coalesceMs?: number
}

export interface PingEngine {
  observe(slice: PingViewSlice): void
  _stateForTesting(): {
    rungNeeds: number
    rungRuns: number
    windowOpen: boolean
  }
}

const COALESCE_MS = 1000
const MAX_LEDGER = 4096

function claimInto(ledger: Set<string>, key: string): boolean {
  if (ledger.has(key)) return false
  ledger.add(key)
  if (ledger.size > MAX_LEDGER) {
    const oldest = ledger.values().next().value
    if (oldest !== undefined) ledger.delete(oldest)
  }
  return true
}

export function createPingEngine(deps: PingEngineDeps): PingEngine {
  const now = deps.nowMs ?? Date.now
  const coalesceMs = deps.coalesceMs ?? COALESCE_MS
  const armAtMs = now()
  const rungNeeds = new Set<string>()
  const rungRuns = new Set<string>()
  let windowUntil = 0

  const tap = (): void => {
    if (!deps.bellEnabled()) return
    const at = now()
    if (at < windowUntil) return
    windowUntil = at + coalesceMs
    deps.ringBell()
  }

  return {
    observe(slice: PingViewSlice): void {
      let fresh = 0
      for (const item of slice.needsYou) {
        if (claimInto(rungNeeds, item.subjectId) && item.atMs > armAtMs) fresh += 1
      }
      for (const item of slice.finishedRuns) {
        if (claimInto(rungRuns, `${item.subjectId}|${item.sourceEventId}`) && item.atMs > armAtMs) {
          fresh += 1
        }
      }
      if (fresh === 0) return
      tap()
    },
    _stateForTesting() {
      return {
        rungNeeds: rungNeeds.size,
        rungRuns: rungRuns.size,
        windowOpen: now() < windowUntil,
      }
    },
  }
}
