// ============================================================================
//  services/saturn/sessionScheduleBridge — the RUNNER-side half of SATURN's
//  facts-borne tool road (the lead's ruling: the runner holds no daemon
//  control client; the R4/kit-completion beat, reversed).
//
//  THE ROAD: a schedule tool edits THIS latch → the next session_facts
//  answer carries the pending edits (send-and-clear: each edit rides
//  EXACTLY ONE answer, because a debounced re-answer that repeated the
//  list would double-apply adds at the seat) → the seat applies each
//  through the record's one writer (by 'model:<sessionId>') and pushes the
//  post-apply roster back down (subtype 'schedule_roster'), so list/remove
//  tools speak real ids. The tool's own answer stays honest: 'submitted —
//  lands on the session record at the daemon beat; the receipt confirms' —
//  zero optimism about record state.
//
//  SEATLESS (a bare `mercury -p` no daemon asked facts): the submit
//  refuses typed — a schedule is a SESSION FACT and this process has no
//  session record. The self-paced wake keeps a lawful seatless arm: a
//  PROCESS-LOCAL wake (armLocalWake) that lives exactly as long as this
//  run — the honest successor of the old session-only wake, with no store
//  anywhere.
// ============================================================================
import { flagEnv } from '../../substrate/flagRegistry.js'
import type { SaturnFactsRowV1, ScheduleOpRequestV1 } from '../../daemon/saturn.js'

let pendingEdits: ScheduleOpRequestV1[] = []
let rosterCache: SaturnFactsRowV1[] | null = null
let seatObserved = false
let wakeSink: ((prompt: string) => void) | null = null
const localWakeTimers = new Set<ReturnType<typeof setTimeout>>()

/** A hostile loop must never grow an unbounded latch — and the cap IS the
 *  seat's own burst clip (daemon/saturn.ts SATURN_EDIT_BURST_CAP, spelled
 *  literally here to keep this runner-side module's graph light;
 *  prove-saturn-adversarial §M1 pins the two equal): back-pressure lands at the
 *  source as a typed refusal, so an edit this latch accepted is never
 *  silently dropped by the seat's clip. */
export const PENDING_SCHEDULE_EDIT_CAP = 20

/** print.ts flips this at its session_facts case — a facts ask proves a
 *  daemon seat listens to this process. */
export function markScheduleSeatObserved(): void {
  seatObserved = true
}

export function scheduleSeatObserved(): boolean {
  return seatObserved
}

export type ScheduleSubmitOutcome =
  | { road: 'seat' }
  | { road: 'refused'; reason: string }

/** Queue one edit for the next facts answer, or refuse typed when no seat
 *  has ever asked (a schedule is a session fact; this process has no
 *  session record). */
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

/** SEND-AND-CLEAR: the facts answer's compose takes the whole latch —
 *  at-most-once by construction. */
export function takePendingScheduleEdits(): ScheduleOpRequestV1[] {
  const taken = pendingEdits
  pendingEdits = []
  return taken
}

/** The daemon's roster push (subtype 'schedule_roster') lands here; the
 *  list/remove tools read it. Null = never pushed. */
export function latchSessionScheduleRoster(rows: SaturnFactsRowV1[]): void {
  rosterCache = rows.map(r => ({ ...r }))
}

export function sessionScheduleRoster(): SaturnFactsRowV1[] | null {
  return rosterCache === null ? null : rosterCache.map(r => ({ ...r }))
}

// ── the process-local wake (the seatless self-pacing arm) ──────────────────

/** The run's own prompt-queue door registers itself here (print.ts's
 *  streaming driver); absent = no local wakes on this surface. */
export function registerLocalWakeSink(sink: (prompt: string) => void): void {
  wakeSink = sink
}

export function localWakeAvailable(): boolean {
  return wakeSink !== null
}

/** Arm one process-local wake: fires the prompt into the run's own queue
 *  after the delay, lives exactly as long as this process, touches no
 *  store. Returns the fire instant. */
export function armLocalWake(delaySeconds: number, prompt: string): { ok: true; atMs: number } | { ok: false; reason: string } {
  const sink = wakeSink
  if (sink === null) return { ok: false, reason: 'this surface has no wake queue — nothing can deliver a local wake here' }
  const atMs = Date.now() + Math.max(1, Math.round(delaySeconds)) * 1000
  const timer = setTimeout(() => {
    localWakeTimers.delete(timer)
    try {
      sink(prompt)
    } catch {
      /* the sink's surface owns its own failures */
    }
  }, Math.max(1000, Math.round(delaySeconds) * 1000))
  timer.unref?.()
  localWakeTimers.add(timer)
  return { ok: true, atMs }
}

// ── the wake-reason fold (MERCURY_WAKE_REASON, re-homed per the lead's
//    ruling — the reason-continuity feature survives the rename) ────────────

/** Canonical spelling — runbooks and provers name one constant. */
export const WAKE_REASON_ENV_FLAG = 'MERCURY_WAKE_REASON'

/** On unless the flag's value is exactly the string "0". */
export function wakeReasonEnabled(): boolean {
  return flagEnv(WAKE_REASON_ENV_FLAG) !== '0'
}

/**
 * Fold a wake reason into the fired prompt as a single bracketed continuity
 * header. Pure; the identity function when there is no reason (after
 * collapsing runs of CR/LF to single spaces and trimming) or when the gate
 * is off — the fired prompt must then be byte-identical.
 */
export function applyWakeReason(prompt: string, reason: string | undefined): string {
  if (!wakeReasonEnabled()) return prompt
  const collapsed = reason?.replace(/[\r\n]+/g, ' ').trim()
  if (!collapsed) return prompt
  return `[self-paced wake — why you woke: ${collapsed}]\n\n${prompt}`
}

/** TEST-ONLY: reset the bridge whole. */
export function _resetScheduleBridgeForTesting(): void {
  pendingEdits = []
  rosterCache = null
  seatObserved = false
  wakeSink = null
  for (const t of localWakeTimers) clearTimeout(t)
  localWakeTimers.clear()
}
