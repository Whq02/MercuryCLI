// ============================================================================
//  utils/cockpit/critterSleep — WHETHER the session critter is asleep.
//
//  Operator ruling:
//  the critter is awake and animating whenever ANY agent is active — the
//  session's own running turn OR any live subagent / in-process teammate /
//  workflow — and drifts to sleep once ZERO agents are running, after a short
//  grace so quick back-to-back turns never flap the state. The critter is the
//  cockpit's one-glance answer to "is anything working right now?".
//
//  THE TRUTH OWNERS, and why there are exactly two:
//    · The SESSION's own turn: companionSignals — the REPL publishes
//      isLoading / streaming / pending-permission from one effect,
//      unconditionally. Same seam as before; push on every edge.
//    · EVERY OTHER agent: the execution plane. The task framework's
//      registerTask/updateTaskState chokepoints mirror every lifecycle move
//      of every task into it (projectTaskExecution), and the plane emits an
//      ordered event per move — so subagents, in-process teammates, remote
//      agents, dreams, and workflow workers all arrive through ONE push
//      seam with no new probe and no polling loop. Kinds counted: 'agent'
//      and 'workflow-worker'. 'background-job' (shells, monitors) is
//      deliberately excluded — a dev server left running is not an agent
//      working, and counting it would pin the critter awake forever.
//    · DAEMON workers: scribe/implementer
//      teammates and their party spawns COUNT. They live out of process
//      with no push edge, so their liveness arrives through the roster
//      owner's SYNC TTL mirror (daemonCrewLivenessSync — the daemonSnapshot
//      idiom: reads refresh it, nothing polls it), consulted at recompute.
//      Because no push exists for them, the elapse clock stays armed
//      through sleep WHILE a supervisor is engaged; with the daemon estate
//      off, the original asleep-drops-the-clock discipline is unchanged.
//
//  Transitions:
//    · WAKE is a PUSH: a companionSignals edge or an execution-plane event
//      recomputes in the same tick. No poll to wait for.
//    · SLEEP is an ELAPSE over the grace window, on the shared uiClock's
//      existing 30s bucket — armed only while awake with subscribers, and
//      dropped entirely once asleep (only a push edge can wake it).
//
//  THE GRACE. BUDDY_FRESH_MS (45s) — deliberately the roster's own
//  fresh-vs-stale threshold, so "recently active" means the same thing for
//  the critter as for every agent-liveness surface. (The companion MOOD
//  engine's 'sleeping' word rides THIS verdict too — operator ruling
// one sleep truth: its old separate 5-minute deep-idle timer
//  is absent, so the word and the art can never disagree.)
//
//  React-free and pure apart from the store itself, so a prover can assert
//  the transitions on a pinned clock instead of racing a live PTY.
// ============================================================================

import { getSessionId, onSessionSwitch } from '../../bootstrap/state.js'
import {
  listExecutions,
  subscribeExecutionEvents,
} from '../../services/primitives/executionPlane.js'
import { processMainOwner } from '../../services/run/resolveOwner.js'
import { flagEnv } from '../../substrate/flagRegistry.js'
import { BUDDY_FRESH_MS } from './buddyState.js'
import {
  companionTurnSignals,
  subscribeCompanionSignals,
  type CompanionTurnSignals,
} from './companionSignals.js'
import { critterFrameKey, swayPhaseAt, type SwayAnchor } from './critterIdle.js'
import { daemonCrewLivenessSync } from './daemonRosterSnapshot.js'
import { subscribeUiClock } from './uiClock.js'

/** Zero agents running for this long and the critter sleeps — the roster's
 *  own fresh-vs-stale window, so the grace can never drift from what the
 *  rest of the estate calls "recent". */
export const SLEEP_AFTER_MS = BUDDY_FRESH_MS

/** The elapse cadence — the companion engine's existing idle bucket, so no
 *  new uiClock timer is created when both are mounted. Against the 45s grace
 *  this lands the sleep verdict 45–75s after the last agent stops. */
export const SLEEP_CHECK_MS = 30_000

/** The execution-plane kinds that count as "an agent is active". */
const AGENT_EXECUTION_KINDS: ReadonlySet<string> = new Set(['agent', 'workflow-worker'])

/** The gate. '0' hard-off (the critter never sleeps); '1' forces the sleeping
 *  state on — the seam captures and provers use, since neither can wait out
 *  the grace for real. Unset ⇒ the live derivation. */
export function critterSleepMode(): 'off' | 'forced' | 'live' {
  const env = flagEnv('MERCURY_CRITTER_SLEEP')
  if (env === '0') return 'off'
  if (env === '1') return 'forced'
  return 'live'
}

/** The agent-activity facts the sleep verdict reads, alongside the session's
 *  own turn signals. Pure-value shape so the prover can pin every case. */
export interface AgentActivity {
  /** ANY live (non-terminal) agent-kind execution exists right now. */
  liveNow: boolean
  /** Epoch ms of the last observed agent-kind execution event (register /
   *  transition / dispose), 0 before any. A stop event is activity AT that
   *  instant — the grace counts from it. */
  lastEventTs: number
}

const NO_AGENTS: AgentActivity = { liveNow: false, lastEventTs: 0 }

/** LIVE read: is any agent-kind execution currently non-terminal for this
 *  process's main owner? Non-throwing — a plane failure reads as quiet
 *  rather than waking the critter on an error. */
export function agentsActiveNow(): boolean {
  try {
    return listExecutions(processMainOwner(), { liveOnly: true }).some(r =>
      AGENT_EXECUTION_KINDS.has(r.spec.kind),
    )
  } catch {
    return false
  }
}

/**
 * PURE: is anything demonstrably ACTIVE right now? The session's own live
 * turn, streaming tokens, a permission ask waiting on the operator — or any
 * live agent execution. Never infers activity it cannot see.
 */
export function signalsActive(s: CompanionTurnSignals): boolean {
  return s.turnLive || s.streaming || s.awaitingPermission
}

/**
 * PURE: the last instant anything was demonstrably active, given the
 * published signals, the agent facts, a session baseline, and the caller's
 * clock. Active NOW reads as `now`; otherwise the latest of the session
 * baseline, the last turn's end, and the last agent event.
 */
export function lastActivityTs(
  s: CompanionTurnSignals,
  baselineTs: number,
  now: number,
  agents: AgentActivity = NO_AGENTS,
): number {
  if (signalsActive(s) || agents.liveNow) return now
  return Math.max(baselineTs, s.lastTurnEndTs ?? 0, agents.lastEventTs)
}

/** PURE: the sleep verdict at `now` — zero agents for at least the grace. */
export function isAsleepAt(
  s: CompanionTurnSignals,
  baselineTs: number,
  now: number,
  agents: AgentActivity = NO_AGENTS,
): boolean {
  return now - lastActivityTs(s, baselineTs, now, agents) >= SLEEP_AFTER_MS
}

// ── the store ───────────────────────────────────────────────────────────────

const listeners = new Set<() => void>()
let unsubSignals: (() => void) | null = null
let unsubExec: (() => void) | null = null
let unsubClock: (() => void) | null = null
let unsubSwitch: (() => void) | null = null
/** Epoch ms this session started counting quiet from. */
let baselineTs = Date.now()
/** Epoch ms of the last agent-kind execution event seen while armed. */
let lastAgentEventTs = 0
/** Epoch ms the critter fell asleep; 0 = awake. A NUMBER (not a boolean) so a
 *  surface can tell how long it has been out without its own bookkeeping, and
 *  so the useSyncExternalStore snapshot stays an Object.is-stable primitive. */
let sleepSince = 0
let sessionKey = ''
/** The sway-phase anchor (critterIdle.swayPhaseAt): pinned to whatever phase
 *  was SHOWING at the last verdict flip, so the drift changes cadence at the
 *  sleep boundary without teleporting position. Owned here because this store
 *  owns the flips. Stamped in EPOCH ms — the same base every derive uses. */
let swayAnchor: SwayAnchor = { phase: 0, at: 0 }

function emit(): void {
  for (const cb of listeners) {
    try {
      cb()
    } catch {
      /* one throwing subscriber never blocks the rest */
    }
  }
}

/** Re-baseline on a session switch: the incoming session counts its own quiet,
 *  never the outgoing session's last turn. */
function ensureSession(): void {
  const sid = getSessionId() || 'boot'
  if (sid === sessionKey) return
  sessionKey = sid
  baselineTs = Date.now()
  sleepSince = 0
}

/** The clock is armed while awake with subscribers — and, since the daemon
 *  ruling, ALSO while asleep with a daemon supervisor ENGAGED: daemon
 *  workers have no in-process push edge, so an asleep critter could never
 *  notice a scribe spawning without the shared elapse. The original drop
 *  ("once asleep only a push can wake") survives whenever the daemon estate
 *  is off — the common case runs exactly the old discipline. */
function armClock(): void {
  const want =
    listeners.size > 0 &&
    critterSleepMode() === 'live' &&
    (sleepSince === 0 || daemonCrewLivenessSync().engaged)
  if (want === (unsubClock !== null)) return
  if (want) unsubClock = subscribeUiClock(SLEEP_CHECK_MS, () => recompute())
  else {
    unsubClock?.()
    unsubClock = null
  }
}

function recompute(): void {
  ensureSession()
  const mode = critterSleepMode()
  const now = Date.now()
  let next: number
  if (mode === 'off') next = 0
  else if (mode === 'forced') next = sleepSince || now
  else {
    // Agent activity = the execution plane's live records (in-process push)
    // OR a live daemon worker (the TTL roster mirror — operator ruling:
    // scribe/implementer teammates and party spawns count).
    const agents: AgentActivity = {
      liveNow: agentsActiveNow() || daemonCrewLivenessSync().workersActive,
      lastEventTs: lastAgentEventTs,
    }
    next = isAsleepAt(companionTurnSignals(), baselineTs, now, agents) ? sleepSince || now : 0
  }
  if (next !== sleepSince) {
    // Pin the sway phase that was SHOWING under the OLD verdict, then flip:
    // the drift continues from the same position at the new cadence (the
    // settle slows in place; the wake quickens in place — no teleport).
    swayAnchor = { phase: swayPhaseAt(now, sleepSince !== 0, swayAnchor), at: now }
    sleepSince = next
    armClock()
    emit()
    return
  }
  armClock()
}

/**
 * The REAL-ACTIVITY push edge for model turns that live OUTSIDE the two
 * standing truth owners (the REPL's companionSignals and the execution
 * plane): the Minerva curator/chat runners and the Helm console's ask
 * engine stamp HERE at their dispatch and settle. A turn on those surfaces
 * is real work and wakes the critter in the same tick; merely OPENING a
 * view (the tabula board, the concourse) is looking, not working — no
 * surface-open path calls this, and the liveness prover pins that a
 * subscribe/mount alone never flips the verdict.
 */
export function noteCritterRealActivity(): void {
  lastAgentEventTs = Date.now()
  recompute()
}

/** The snapshot: epoch ms the critter fell asleep, or 0 while awake. */
export function critterSleepSince(): number {
  return sleepSince
}

/** The live sway anchor (see critterIdle.swayPhaseAt). Read at derive time by
 *  every animated mount so all critters share one continuous drift. */
export function critterSwayAnchor(): SwayAnchor {
  return swayAnchor
}

/** True while the session critter is asleep. */
export function isCritterAsleep(): boolean {
  return sleepSince !== 0
}

/**
 * THE live frame key — the one derive every animated critter mount runs.
 *
 * It lives HERE, beside the stamps it reads, because the freeze class
 * was exactly a split ownership: the store stamped `sleepSince` and the sway
 * anchor in EPOCH ms while the view derived with the ink Clock's
 * process-relative time, so `time - sleepSince` pinned at zero — the clock
 * kept ticking, every derive returned the same frame, and the Zzz froze
 * (and, after a wake, the sway never advanced past the stamped anchor: the
 * reported wake-stall). One owner reading ONE time base makes the mismatch
 * unrepresentable; the prover drives this exact function across simulated
 * hours. `now` is injectable for proofs and defaults to the base the stamps
 * actually use.
 */
export function critterLiveFrameKey(now: number = Date.now()): string {
  return critterFrameKey(now, sleepSince !== 0, swayAnchor, sleepSince)
}

export function subscribeCritterSleep(cb: () => void): () => void {
  listeners.add(cb)
  if (listeners.size === 1) {
    unsubSignals = subscribeCompanionSignals(() => recompute())
    // Agent lifecycle push: every task status move mirrors into the
    // execution plane and lands here in the same tick — the wake edge for
    // subagents, teammates, and workflows. The stamp is taken for
    // agent-kind events only, so a background shell's churn never counts.
    unsubExec = subscribeExecutionEvents(ev => {
      const record = 'record' in ev.event ? ev.event.record : undefined
      if (!record || !AGENT_EXECUTION_KINDS.has(record.spec.kind)) return
      lastAgentEventTs = Date.now()
      recompute()
    })
    unsubSwitch = onSessionSwitch(() => recompute())
    recompute()
  }
  return () => {
    listeners.delete(cb)
    if (listeners.size === 0) {
      // Last critter surface gone: a session with nothing to animate runs no
      // subscriptions and no timer.
      unsubSignals?.()
      unsubSignals = null
      unsubExec?.()
      unsubExec = null
      unsubSwitch?.()
      unsubSwitch = null
      unsubClock?.()
      unsubClock = null
    }
  }
}

/** Proof seam: live resource counts (the shape prove-critter-sleep asserts). */
export function critterSleepStatsForProofs(): {
  listeners: number
  clockArmed: boolean
  signalsArmed: boolean
  execArmed: boolean
  asleep: boolean
} {
  return {
    listeners: listeners.size,
    clockArmed: unsubClock !== null,
    signalsArmed: unsubSignals !== null,
    execArmed: unsubExec !== null,
    asleep: sleepSince !== 0,
  }
}

/** Proof seam: hard reset (never called by session code). Pins `sessionKey`
 *  to the CURRENT session id so the staged `nowMs` baseline SURVIVES the next
 *  recompute — with the old empty key, ensureSession's re-baseline silently
 *  clobbered whatever a prover staged, which made aged-baseline drives
 *  vacuously awake. */
export function resetCritterSleepForTests(nowMs: number = Date.now()): void {
  sleepSince = 0
  baselineTs = nowMs
  lastAgentEventTs = 0
  sessionKey = getSessionId() || 'boot'
  swayAnchor = { phase: 0, at: 0 }
  emit()
}
