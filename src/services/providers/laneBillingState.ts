import type { CallModelRoute } from './idSpaces.js'

export type LaneBillingState =
  | { state: 'credit-exhausted'; observedAtMs: number; detail: string; remedy: string }
  | { state: 'clear' }

const observed = new Map<CallModelRoute, { observedAtMs: number; detail: string; remedy: string }>()

export function recordLaneBillingRefusal(
  lane: CallModelRoute,
  refusal: { detail: string; remedy: string },
  now: () => number = Date.now,
): void {
  observed.set(lane, { observedAtMs: now(), detail: refusal.detail, remedy: refusal.remedy })
}

export function recordLaneTurnSettled(lane: CallModelRoute): void {
  observed.delete(lane)
}

export function laneBillingState(lane: CallModelRoute): LaneBillingState {
  const record = observed.get(lane)
  return record === undefined
    ? { state: 'clear' }
    : { state: 'credit-exhausted', observedAtMs: record.observedAtMs, detail: record.detail, remedy: record.remedy }
}

export function __resetLaneBillingStateForTest(): void {
  observed.clear()
}
