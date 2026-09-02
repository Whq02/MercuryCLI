// ============================================================================
//  liveCountBridge — token-burn awareness for the Mercury chrome.
//  Sources:
//  src/lib/sessionScope.ts (sessionPositivelyForeign). This is the FRAMEWORK-
//  AGNOSTIC half: the pure scope predicate, the dual-poll cadence constants, the
//  honest LiveCounts shape, and the snapshot reads. The React/Ink chip lives in
//  commands/status/liveCountChip.tsx and reads through this bridge only.
//
//  WHAT IT COUNTS (two honest, already-served signals):
//    • live sessions   — agents actively spending tokens RIGHT NOW.
//                        re-pointed this axis to SUPERVISOR TRUTH: self
//                        (the visible model-bearing REPL is managed session #1,
//                        ruling 26) + live Concourse session workers
//                        (concourseSupervisor records ∩ positive pid liveness).
//                        The old PID-registry count retired from this axis; the
//                        registry itself remains the ps/ListPeers/Remote-Control
//                        peer-enumeration surface only.
//    • running workflows — fan-outs with ≥1 still-running agent. The earlier surface read
//                        GET /api/workflows (Workflow-tool fan-outs); Mercury's
//                        fan-out substrate is the swarm/team (computeAgentHealth):
//                        a `busy`/`drifting` teammate is a running fan-out member.
//
//  HONESTY GATE (the bridge-heartbeat lesson: a live count is provable or it is zero):
//    It zeroed the workflow count + froze the spinner when the 6s bridge
//    heartbeat went stale (an on-disk 'running' is ghost-LIVE once the bridge is
//    gone). Mercury's equivalent "bridge" for the workflow axis is being IN A
//    TEAM: no team ⇒ no swarm fan-out is possible ⇒ runningWorkflows is honestly 0
//    and `bridgeConnected` is false. A read that fails fails SAFE to zeros — a
//    missing source is a state, not a crash.
//
//  CADENCE (cloned from the source): live sessions refresh briskly (cheap PID
//  scan), workflows on a slower beat (the agent-health read touches leases + the
//  roster). Both are exported so the chip's two intervals match the source's
//  split-poll discipline (SESSION_POLL_MS / WORKFLOW_POLL_MS).
// ============================================================================

import { getTeamName } from './teammate.js'
import {
  computeAgentHealth,
  type AgentHealth,
} from './swarm/roomHealth.js'
import { listLeases, type Lease } from './swarm/leaseGlob.js'
import { getAgentStatuses, type AgentStatus } from './tasks.js'

// --- Cadence (verbatim from LiveCountChip.tsx) ------------------------------
/** Live-turn count — cheap PID scan, refresh briskly. */
export const SESSION_POLL_MS = 2000
/** Workflow/fan-out scan — heavier (leases + roster), refresh slower. */
export const WORKFLOW_POLL_MS = 5000

// --- The honest counts shape (mirrors LiveCounts in the source) -------------
export interface LiveCounts {
  /** Agents actively spending tokens now (live concurrent sessions). */
  liveSessions: number
  /** All account-scoped sessions the harness knows, live or idle. Mercury's
   *  PID registry only tracks live processes, so this equals liveSessions today;
   *  kept distinct so a future idle-session source slots in without a shape change
   *  (the source carried both). */
  sessionCount: number
  /** Workflow / swarm fan-outs with ≥1 still-running agent. */
  runningWorkflows: number
  /** The swarm "bridge": true iff in a team (a fan-out is even possible). A false
   *  here zeros the workflow count at the render site — never a ghost-LIVE wf. */
  bridgeConnected: boolean
}

export const EMPTY_COUNTS: LiveCounts = {
  liveSessions: 0,
  sessionCount: 0,
  runningWorkflows: 0,
  bridgeConnected: false,
}

// --- The pure scope predicate (verbatim port of sessionScope.ts) ------------
//  Preserved exactly so the load-bearing "hide only PROVABLY-foreign" rule cannot
//  drift into a render site (the gotcha: mirrored CLI sessions have no
//  supervisor row / uuid, so a strict belongs-to rule DROPS sessions the live view
//  shows; surfaces must use this dual rule). Mercury's own PID dir is already
//  account-local, so today nothing is positively-foreign — but porting the rule
//  keeps the contract honest if per-account stamping arrives, and it stays
//  framework-agnostic + node-testable here.

/** Minimal session-status row this predicate reads (a structural subset of the
 *  source SessionStatus): an optional mirror-stamped account uuid. */
export interface ScopedSessionRow {
  accountUuid?: string
}

export interface AccountScopeInputs {
  /** The active launch-account id. */
  activeId: string
  /** Authoritative sessionId → launch-account-id map (supervisor roster), when
   *  one exists. Empty in Mercury today (no multi-account supervisor). */
  sessionAccount: ReadonlyMap<string, string>
  /** The active account's oauthAccount.accountUuid, when known — the secondary
   *  positive signal for sessions the supervisor does not track. */
  activeUuid?: string
}

/** True iff session `sid` is POSITIVELY attributable to a DIFFERENT account than
 *  the active one. Supervisor map first (authoritative), then the mirror-stamped
 *  accountUuid. No positive signal ⇒ NOT foreign (unprovable rows stay visible —
 *  the watch-only mirror feature). Verbatim from sessionScope.sessionPositivelyForeign. */
export function sessionPositivelyForeign(
  sid: string,
  s: ScopedSessionRow | undefined,
  inp: AccountScopeInputs,
): boolean {
  const mapped = inp.sessionAccount.get(sid)
  if (mapped !== undefined) return mapped !== inp.activeId
  return !!inp.activeUuid && !!s?.accountUuid && s.accountUuid !== inp.activeUuid
}

// --- Pure fan-out folding (node-testable, no fs/clock) -----------------------

/** Count fan-outs with ≥1 still-running agent from a computed health roster.
 *  Mirrors the source's `groups.filter(g => g.agents.some(a => a.status === 'running'))`:
 *  a `busy` or `drifting` teammate is a running fan-out member (idle ones aren't
 *  spending). Mercury is one team per process, so a running team folds to its
 *  count of running members (each is a live fan-out arm). Pure. */
export function countRunningWorkflows(health: readonly AgentHealth[]): number {
  return health.filter(a => a.state === 'busy' || a.state === 'drifting').length
}

// --- The honest snapshot reads (the impure edge; both fail SAFE to zeros) -----

/** Live sessions this supervisor answers for (migration —
 *  supervisor truth replaced the PID-registry count): SELF (the visible
 *  model-bearing REPL is managed session #1, ruling 26) + the live Concourse
 *  workers (records ∩ positive pid liveness). Failure ⇒ the honest floor of
 *  1 (self exists — the caller IS a session). */
export async function readLiveSessions(): Promise<{ liveSessions: number; sessionCount: number }> {
  try {
    const { countLiveConcourseWorkers } = await import('../daemon/concourseSupervisor.js')
    const n = 1 + countLiveConcourseWorkers()
    return { liveSessions: n, sessionCount: n }
  } catch {
    return { liveSessions: 1, sessionCount: 1 }
  }
}

/** Running swarm fan-outs + the honest bridge gate. No team ⇒ { 0, false } (the
 *  fork has no swarm "bridge" to be live, so the wf count is honestly absent, not
 *  faked). A read failure ⇒ same safe zero. */
export async function readRunningWorkflows(): Promise<{ runningWorkflows: number; bridgeConnected: boolean }> {
  const teamName = getTeamName() ?? null
  if (!teamName) return { runningWorkflows: 0, bridgeConnected: false }
  try {
    const nowMs = Date.now()
    const [statuses, leases] = await Promise.all([
      getAgentStatuses(teamName).catch(() => null as AgentStatus[] | null),
      listLeases(teamName, { nowMs }).catch(() => [] as Lease[]),
    ])
    const health = computeAgentHealth(statuses ?? [], leases, { nowMs })
    return { runningWorkflows: countRunningWorkflows(health), bridgeConnected: true }
  } catch {
    // In a team but the read failed — bridge is "present but unreadable": honest 0,
    // and we DON'T claim connected (don't spin a count we couldn't verify).
    return { runningWorkflows: 0, bridgeConnected: false }
  }
}
