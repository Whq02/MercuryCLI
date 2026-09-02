// ============================================================================
//  implementerTelemetry — the Scribe's live view of its daemon-hosted Implementer.
//
//  The Scribe runs in the foreground; the Implementer runs in the daemon. The
//  per-turn awareness reminder (scribeAwareness) is built SYNC on the prompt path,
//  so it can't do a blocking `list` RPC. This module mirrors contextUsageLive: a
//  light self-armed poll (the Scribe foreground only) does the async
//  daemonRosterSnapshot RPC every few seconds and PUBLISHES the distilled telemetry
//  to a module-global; the awareness builder reads it SYNC. So the Scribe stops
//  being BLIND — it sees context fill / busy / restarts / a wedged backend and can
//  decide to clear-or-route + report honestly, instead of dispatching into a void.
//
//  Honest by construction: the cache starts EMPTY (daemonUp:false) so a fresh
//  session adds no telemetry line until a real poll has answered — never a fabricated
//  state. Self-gating + idempotent: the poll arms only when scribe MODE is on
//  (isScribeModeOn — set by the MERCURY_SCRIBE=1 launch AND the /model carousel engage,
//  unlike the role env which the carousel never sets), and never more than once.
// ============================================================================
import { daemonRosterSnapshot } from '../cockpit/daemonRosterSnapshot.js'
import { scribeModeEnabled } from './scribeGates.js'
import { isScribeModeOn } from '../scribeMode.js'
import { flagEnv } from '../../substrate/flagRegistry.js'

export interface ImplementerTelemetry {
  /** The daemon answered the list RPC at all. */
  daemonUp: boolean
  /** The Implementer is in the roster (a live or settled entry exists). */
  present: boolean
  /** The RUNNING child's model/effort (roster spawn-captured — display
   *  truth for the /model ROLES row while scribe mode is engaged). */
  model?: string
  effort?: string
  /** A queued/in-flight retarget's requested values ("applies at turn end"). */
  pendingModel?: string
  pendingEffort?: string
  /** Mid-task (a dispatch in flight) per the daemon's precise turn-active signal. */
  busy?: boolean
  /** Latest context-window fill % (0-100), parsed from its stream-json usage frames. */
  contextPct?: number
  /** Elapsed ms on the Implementer's CURRENT turn (busy-only; absent when idle). Lets
   *  the Scribe say HOW LONG it's been working and flag a stall — time-blindness fix. */
  turnElapsedMs?: number
  /** Supervisor respawns (crash + reconfigure/auto-clear respawns). */
  respawns?: number
  /** The entry has SETTLED (outcome set) ⇒ the backend is dead/degraded, not live. */
  settled?: boolean
}

const EMPTY: ImplementerTelemetry = { daemonUp: false, present: false }
let _cache: ImplementerTelemetry = EMPTY

/** Publish distilled Implementer telemetry (called by the poll; exposed for tests). */
export function publishImplementerTelemetry(t: ImplementerTelemetry): void {
  _cache = t
}

/** Read the latest published Implementer telemetry (SYNC — the awareness builder). */
export function getImplementerTelemetry(): ImplementerTelemetry {
  return _cache
}

/**
 * One honest backend-state clause for a dispatch SEND ACK (the
 * OpenRouter route-time-health pattern): the router tells the caller the
 * counterpart's health AT THE MOMENT OF ROUTING, so "sent" never reads as
 * "received" against a dead or wedged backend — the operator sat through
 * "Nothing back yet — still holding" with zero liveness context. Pure over
 * the published telemetry; never fabricates (no confirmed poll ⇒ says so).
 */
export function composeDispatchAckHealth(
  t: ImplementerTelemetry,
  opts?: {
    /** THIS send just round-tripped the daemon's authed socket (rpc.ok) — a
     *  fresher daemon-liveness fact than any poll cache. In the pre-first-poll
     *  window the cache is EMPTY, and without this floor the ack literally
     *  said "no daemon answer yet" about a send the daemon just answered
     * Floors ONLY daemon-up; roster facts stay poll-owned. */
    rpcConfirmed?: boolean
  },
): string {
  if (!t.daemonUp) {
    return opts?.rpcConfirmed
      ? 'daemon answered this send (journaled + nudged) — backend telemetry pending its first poll; a reply typically lands in 1–3 min'
      : 'backend UNCONFIRMED (no daemon answer yet) — send≠receipt; treat silence past ~3 min as a fault, not patience'
  }
  if (!t.present) return 'backend MISSING from the daemon roster — the dispatch will sit until an Implementer spawns; escalate if this persists'
  if (t.settled) return 'backend SETTLED (dead/degraded) — the daemon must respawn it before this delivers'
  if (t.busy) {
    const mins = t.turnElapsedMs !== undefined ? ` ~${Math.max(1, Math.round(t.turnElapsedMs / 60_000))} min in` : ''
    return `backend MID-TASK${mins} — held for delivery at the next idle boundary (one task at a time)`
  }
  return 'backend LIVE (idle) — delivery is immediate; first reply typically lands in 1–3 min'
}

/** Default poll cadence (ms); env-tunable via MERCURY_SCRIBE_TELEMETRY_MS. */
const DEFAULT_POLL_MS = 5000
function pollMs(): number {
  const n = Number(flagEnv('MERCURY_SCRIBE_TELEMETRY_MS'))
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_POLL_MS
}

/** One refresh: the async list RPC → distilled cache. Never throws. In-flight
 *  guarded: the RPC self-terminates (2s ETIMEOUT) but the poll cadence is
 *  env-tunable (MERCURY_SCRIBE_TELEMETRY_MS) — a 100ms tune would otherwise
 *  stack ~20 concurrent RPCs against a wedged daemon. */
let _refreshing = false
async function refresh(): Promise<void> {
  if (_refreshing) return
  _refreshing = true
  try {
    const snap = await daemonRosterSnapshot('implementer')
    if (!snap.ok) {
      _cache = { daemonUp: false, present: false }
      return
    }
    const e = snap.entry
    _cache = e
      ? {
          daemonUp: true,
          present: true,
          model: e.model,
          effort: e.effort,
          pendingModel: e.pendingModel,
          pendingEffort: e.pendingEffort,
          busy: e.busy,
          contextPct: e.contextPct,
          turnElapsedMs: e.turnElapsedMs,
          respawns: e.respawns,
          settled: e.outcome !== undefined,
        }
      : { daemonUp: true, present: false }
  } catch {
    /* keep the last known value rather than flapping to empty on a transient error */
  } finally {
    _refreshing = false
  }
}

let _armed = false

/**
 * Arm the foreground telemetry poll. Idempotent; a no-op unless scribe MODE is on (so a
 * normal session / the Implementer never polls). The interval is unref'd so it never keeps
 * the process alive. `deps` injectable for tests.
 *
 * Gate on the MODE (isScribeModeOn), not the role env (isScribeRole): the /model carousel
 * engage flips only the module boolean (setScribeMode), never MERCURY_SCRIBE, so an
 * isScribeRole() gate left the poll DEAD on the operator's actual engage path — the Scribe
 * then stayed BLIND (getImplementerTelemetry() empty) and the awareness reminder falsely
 * read "NO confirmed-live Implementer / cannot take execution on" every turn. Mirrors the
 * BriefTool keystone + scribeAwareness gate, which already key on the mode. The
 * scribeModeEnabled() AND keeps OFF byte-identical (the retired branch folded
 * away); on the MERCURY_SCRIBE=1 launch scribeOn inits true ⇒ behavior is unchanged there.
 */
export function armImplementerTelemetryPoll(deps?: { refresh?: () => Promise<void> }): boolean {
  if (_armed) return false
  if (!(scribeModeEnabled() && isScribeModeOn())) return false
  _armed = true
  const tick = deps?.refresh ?? refresh
  void tick()
  const t = setInterval(() => void tick(), pollMs())
  t.unref?.()
  return true
}

/** Test-only: reset the cache + arm guard. */
export function __resetImplementerTelemetryForTests(): void {
  _cache = EMPTY
  _armed = false
}
