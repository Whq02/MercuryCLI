// ============================================================================
// the authoritative turn-phase state machine.
//
//  ONE phase source of truth for "what is Mercury doing right now", derived
//  from REAL lifecycle events (submit capture, hook waits, attachment
//  collection, actual HTTP dispatch, stream deltas, tool execution, turn
//  settlement) — never inferred from token counts. The legacy five-phase
//  `SpinnerMode` becomes a PROJECTION of this state (`projectSpinnerMode`),
//  not a second system.
//
//  Contracts (proved in scripts/pulse/):
//  · Monotonic per-turn: every transition is generation-fenced — a write from
//    an old/cancelled turn can NEVER mutate a newer turn's phase.
//  · Transitions are immediate INTERNALLY; visual dwell/hysteresis is a view
//    concern (`computeDisplayPhase`) so honest timestamps survive even when a
//    label is visually suppressed.
//  · Stream activity (token cadence for the stall view) lives in a
//    NON-NOTIFYING slot read on the animation clock — per-token store
//    notifications would put the whole spinner tree back on the token clock.
//  · Store pattern: module store + useSyncExternalStore (module-state needs
//    uSES — the keybinding/frame-toggle lesson).
// ============================================================================

import { useSyncExternalStore } from 'react'
import type { SpinnerMode } from '../../components/Spinner/types.js'

/** The semantic turn phases, in causal order. `tool-work` legally cycles back
 *  through `preparing`/`dispatching` (the next model-call iteration of the
 *  same operator turn re-builds context and re-dispatches — honesty over
 *  strict forward-only). */
export type TurnPhaseName =
  | 'idle'
  | 'accepted'
  | 'preparing'
  | 'compacting'
  | 'dispatching'
  | 'waiting'
  | 'thinking'
  | 'responding'
  | 'tool-work'
  | 'settling'

/** Compact operator-facing cause while `preparing` (shown only after dwell). */
export type PreparingReason = 'input' | 'hooks' | 'context' | 'workspace'

export type StreamKind = 'thinking' | 'text' | 'tool-input'

export type PhaseDetail = {
  reason?: PreparingReason
  /** The ACTUAL selected model for the in-flight call (display name). */
  model?: string
  /** The APPLIED effort for the in-flight call. */
  effort?: string
  /** The model that is SERVING the call when it is not the requested one
   *  (the opt-in refusal fallback; display name) — the byline names it. */
  servedBy?: string
  /** Leader tool_use blocks in flight (tool-work byline: "Running 3 tools"). */
  toolCount?: number
  /** The request wait's own words while the first byte is outstanding or a
   *  reissue is on its way ("ingesting a 26k-token prompt on Opus 5 —
   *  first byte expected within 90 s"); absent once the stream flows. */
  wait?: string
}

export type TurnPhaseSnapshot = {
  /** Monotonic turn generation — shared with the turn trace (one identity). */
  generation: number
  phase: TurnPhaseName
  detail: PhaseDetail
  /** pulseNow() at entry into the CURRENT phase. */
  enteredAt: number
  /** pulseNow() at submit_received for this generation (0 when idle). */
  turnStartedAt: number
}

/** Token-cadence truth for the stall view — read by pull on the animation
 *  clock, never notified. `first*At` are pulseNow() stamps, null until seen. */
export type PulseStreamActivity = {
  generation: number
  lastEventAt: number | null
  lastKind: StreamKind | 'chunk' | null
  firstChunkAt: number | null
  firstThinkingAt: number | null
  firstTextAt: number | null
}

// ── the monotonic clock seam ────────────────────────────────────────────────
// performance.now() (global since Node 16) — never wall-clock subtraction.
// Deterministic proofs pin the clock via setPulseClockForTests.

let clock: () => number = () => performance.now()

export function pulseNow(): number {
  return clock()
}

export function setPulseClockForTests(fn: (() => number) | null): void {
  clock = fn ?? (() => performance.now())
}

/** Test seam (called via resetPulseForTests): wipe the phase store back to
 *  the boot state so deterministic proofs start from a clean generation. */
export function resetPhaseForTests(): void {
  snapshot = IDLE_SNAPSHOT
  activity = {
    generation: 0,
    lastEventAt: null,
    lastKind: null,
    firstChunkAt: null,
    firstThinkingAt: null,
    firstTextAt: null,
  }
  notify()
}

// ── the store ───────────────────────────────────────────────────────────────

const IDLE_SNAPSHOT: TurnPhaseSnapshot = {
  generation: 0,
  phase: 'idle',
  detail: {},
  enteredAt: 0,
  turnStartedAt: 0,
}

let snapshot: TurnPhaseSnapshot = IDLE_SNAPSHOT
let activity: PulseStreamActivity = {
  generation: 0,
  lastEventAt: null,
  lastKind: null,
  firstChunkAt: null,
  firstThinkingAt: null,
  firstTextAt: null,
}
const listeners = new Set<() => void>()

function notify(): void {
  for (const l of listeners) l()
}

/** Same-generation legal transitions. A NEW generation always resets to
 *  `accepted` (beginPhaseGeneration bypasses the table); `idle` is reached
 *  only through `settling` or a hard reset. `preparing → preparing` is legal
 *  (reason refinement). */
const ALLOWED: Record<TurnPhaseName, readonly TurnPhaseName[]> = {
  idle: ['accepted'],
  accepted: ['preparing', 'compacting', 'dispatching', 'settling'],
  preparing: ['preparing', 'compacting', 'dispatching', 'settling'],
  compacting: ['preparing', 'compacting', 'dispatching', 'settling'],
  dispatching: ['waiting', 'settling'],
  waiting: ['thinking', 'responding', 'tool-work', 'settling'],
  thinking: ['thinking', 'responding', 'tool-work', 'settling'],
  responding: ['thinking', 'responding', 'tool-work', 'settling'],
  'tool-work': [
    'preparing',
    'compacting',
    'dispatching',
    'thinking',
    'responding',
    'tool-work',
    'settling',
  ],
  settling: ['idle'],
}

/** Open a new turn generation at the REAL submit boundary. Called by the
 *  turn-trace owner (beginPulseTurn) so trace + phase share one generation —
 *  do not call directly from UI. */
export function beginPhaseGeneration(generation: number): void {
  const now = pulseNow()
  snapshot = {
    generation,
    phase: 'accepted',
    detail: {},
    enteredAt: now,
    turnStartedAt: now,
    }
  activity = {
    generation,
    lastEventAt: null,
    lastKind: null,
    firstChunkAt: null,
    firstThinkingAt: null,
    firstTextAt: null,
  }
  notify()
}

/** Generation-fenced transition. Returns true when applied. Illegal
 *  transitions and stale-generation writes are DROPPED (never throw — a late
 *  event from a cancelled turn is normal, not a bug). Detail merges; a phase
 *  self-transition with identical detail is a no-op (no render churn). */
export function setPulsePhase(
  generation: number,
  phase: TurnPhaseName,
  detail?: PhaseDetail,
): boolean {
  if (generation !== snapshot.generation) return false
  if (phase !== snapshot.phase && !ALLOWED[snapshot.phase].includes(phase)) {
    return false
  }
  const mergedDetail = detail
    ? { ...snapshot.detail, ...detail }
    : snapshot.detail
  if (phase === snapshot.phase && !detailChanged(snapshot.detail, mergedDetail)) {
    return true
  }
  snapshot = {
    ...snapshot,
    phase,
    detail: mergedDetail,
    enteredAt: phase === snapshot.phase ? snapshot.enteredAt : pulseNow(),
  }
  notify()
  return true
}

function detailChanged(a: PhaseDetail, b: PhaseDetail): boolean {
  return (
    a.reason !== b.reason ||
    a.model !== b.model ||
    a.effort !== b.effort ||
    a.servedBy !== b.servedBy ||
    a.toolCount !== b.toolCount
  )
}

/** Close the generation's lifecycle: settling → idle. Fenced like the rest. */
export function finishPhaseGeneration(generation: number): void {
  if (generation !== snapshot.generation) return
  if (snapshot.phase !== 'idle') {
    snapshot = { ...snapshot, phase: 'idle', enteredAt: pulseNow(), detail: {} }
    notify()
  }
}

/** Record stream cadence WITHOUT notifying subscribers (pull-based — the
 *  animation clock reads this each frame). First-seen stamps latch once. */
export function notePulseStreamActivity(
  generation: number,
  kind: StreamKind | 'chunk',
): void {
  if (generation !== snapshot.generation) return
  const now = pulseNow()
  if (activity.generation !== generation) return
  activity = {
    ...activity,
    lastEventAt: now,
    lastKind: kind,
    firstChunkAt: activity.firstChunkAt ?? now,
    firstThinkingAt:
      kind === 'thinking' ? (activity.firstThinkingAt ?? now) : activity.firstThinkingAt,
    firstTextAt: kind === 'text' ? (activity.firstTextAt ?? now) : activity.firstTextAt,
  }
}

export function getPulseActivity(): PulseStreamActivity {
  return activity
}

export function getPulsePhase(): TurnPhaseSnapshot {
  return snapshot
}

export function subscribePulsePhase(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** The UI subscription — referentially stable snapshots, notify-on-change. */
export function usePulsePhase(): TurnPhaseSnapshot {
  return useSyncExternalStore(subscribePulsePhase, getPulsePhase, getPulsePhase)
}

// ── projections ─────────────────────────────────────────────────────────────

/** The legacy five-phase SpinnerMode as a PROJECTION of the phase machine.
 *  Pre-flight phases all read as 'requesting' (the info-channel pre-token
 *  paint already assigned); the stream kinds keep their modes. */
export function projectSpinnerMode(
  phase: TurnPhaseName,
  lastKind?: StreamKind | 'chunk' | null,
): SpinnerMode {
  switch (phase) {
    case 'thinking':
      return 'thinking'
    case 'responding':
      return lastKind === 'tool-input' ? 'tool-input' : 'responding'
    case 'tool-work':
      return 'tool-use'
    case 'settling':
      return 'responding'
    case 'idle':
      return 'responding'
    default:
      // accepted | preparing | compacting | dispatching | waiting — in flight,
      // no token yet.
      return 'requesting'
  }
}

/** Dwell/hysteresis for the VIEW (brief: ~160–250ms): a detailed preparation
 *  subphase (preparing-with-reason / compacting / dispatching) only becomes
 *  visible once it has survived `dwellMs`; until then the display holds the
 *  prior coarse label. Transitions stay immediate internally — callers pass
 *  the previous DISPLAYED phase and the honest snapshot. Pure: drive it from
 *  any clock in tests. */
export function computeDisplayPhase(
  prevDisplayed: TurnPhaseName,
  snap: TurnPhaseSnapshot,
  now: number,
  dwellMs = 200,
): TurnPhaseName {
  const detailSubphase =
    snap.phase === 'preparing' ||
    snap.phase === 'compacting' ||
    snap.phase === 'dispatching'
  if (!detailSubphase) return snap.phase
  if (now - snap.enteredAt >= dwellMs) return snap.phase
  // Not yet dwelled: hold the previous display if it was a coarser/earlier
  // label of the same turn; otherwise show the generic entry phase.
  if (prevDisplayed === 'idle' || prevDisplayed === 'settling') return 'accepted'
  return prevDisplayed
}
