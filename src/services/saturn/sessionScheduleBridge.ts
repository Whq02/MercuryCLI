import { flagEnv } from '../../substrate/flagRegistry.js'
import type { SaturnFactsRowV1, ScheduleOpRequestV1 } from '../../daemon/saturn.js'

let pendingEdits: ScheduleOpRequestV1[] = []
let rosterCache: SaturnFactsRowV1[] | null = null
let seatObserved = false
let wakeSink: ((prompt: string) => void) | null = null
const localWakeTimers = new Set<ReturnType<typeof setTimeout>>()

export const PENDING_SCHEDULE_EDIT_CAP = 20

export function markScheduleSeatObserved(): void {
  seatObserved = true
}

export function scheduleSeatObserved(): boolean {
  return seatObserved
}

export type ScheduleSubmitOutcome =
  | { road: 'seat' }
  | { road: 'refused'; reason: string }

export function submitSessionScheduleEdit(edit: ScheduleOpRequestV1): ScheduleSubmitOutcome {
  if (!seatObserved) {
    return {
      road: 'refused',
      reason:
        'this run has no session record — schedules live on concourse sessions (the daemon applies them); a bare headless run can arm a process-local wake instead',
    }
  }
  if (pendingEdits.length >= PENDING_SCHEDULE_EDIT_CAP) {
    return { road: 'refused', reason: `too many pending schedule edits (${PENDING_SCHEDULE_EDIT_CAP}) — the seat has not drained yet` }
  }
  pendingEdits = [...pendingEdits, edit]
  return { road: 'seat' }
}

export function takePendingScheduleEdits(): ScheduleOpRequestV1[] {
  const taken = pendingEdits
  pendingEdits = []
  return taken
}

export function latchSessionScheduleRoster(rows: SaturnFactsRowV1[]): void {
  rosterCache = rows.map(r => ({ ...r }))
}

export function sessionScheduleRoster(): SaturnFactsRowV1[] | null {
  return rosterCache === null ? null : rosterCache.map(r => ({ ...r }))
}


export function registerLocalWakeSink(sink: (prompt: string) => void): void {
  wakeSink = sink
}

export function localWakeAvailable(): boolean {
  return wakeSink !== null
}

export function armLocalWake(delaySeconds: number, prompt: string): { ok: true; atMs: number } | { ok: false; reason: string } {
  const sink = wakeSink
  if (sink === null) return { ok: false, reason: 'this surface has no wake queue — nothing can deliver a local wake here' }
  const atMs = Date.now() + Math.max(1, Math.round(delaySeconds)) * 1000
  const timer = setTimeout(() => {
    localWakeTimers.delete(timer)
    try {
      sink(prompt)
    } catch {
    }
  }, Math.max(1000, Math.round(delaySeconds) * 1000))
  timer.unref?.()
  localWakeTimers.add(timer)
  return { ok: true, atMs }
}


export const WAKE_REASON_ENV_FLAG = 'MERCURY_WAKE_REASON'

export function wakeReasonEnabled(): boolean {
  return flagEnv(WAKE_REASON_ENV_FLAG) !== '0'
}

export function applyWakeReason(prompt: string, reason: string | undefined): string {
  if (!wakeReasonEnabled()) return prompt
  const collapsed = reason?.replace(/[\r\n]+/g, ' ').trim()
  if (!collapsed) return prompt
  return `[self-paced wake — why you woke: ${collapsed}]\n\n${prompt}`
}

export function _resetScheduleBridgeForTesting(): void {
  pendingEdits = []
  rosterCache = null
  seatObserved = false
  wakeSink = null
  for (const t of localWakeTimers) clearTimeout(t)
  localWakeTimers.clear()
}
