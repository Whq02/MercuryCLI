// daemonRosterSnapshot — the foreground reader for dual-agent telemetry (W5).
//
// Unlike daemonSnapshot (a cheap SYNC supervisor-liveness probe used on the
// per-render path), this issues the heavier `list` control RPC to read a specific
// long-lived worker's wire entry (model / effort / contextPct / respawns / live).
// It is ASYNC and is consumed OFF the render path — the deck reads it on its ~5s
// tick and caches the result. Never throws: any transport failure (no daemon,
// refused, timeout) degrades to {ok:false, implementer:null}, honest like the rest
// of utils/cockpit.
import { getSessionId } from '../../bootstrap/state.js'
import { daemonControlRpc } from '../../daemon/controlSocket.js'
import type { DaemonRequest, WireRosterEntry } from '../../daemon/protocol.js'
import { daemonSnapshot } from './daemonSnapshot.js'

export type RosterSnapshot = {
  /** True iff a daemon answered the list RPC. */
  ok: boolean
  /** The requested worker's wire entry, or null (no daemon / not in the roster). */
  entry: WireRosterEntry | null
  /** One-line human reason ('live' | 'not in roster' | an error code). */
  reason: string
}

/**
 * Read a long-lived worker's telemetry from the daemon roster. Defaults to the
 * Amanuensis Implementer. The control client auto-stamps proto + the control key,
 * so we pass only the op. Returns honestly when there's no daemon.
 */
export async function daemonRosterSnapshot(
  short = 'implementer',
): Promise<RosterSnapshot> {
  try {
    const reply = await daemonControlRpc({ op: 'list' } as DaemonRequest)
    if (!reply.ok) {
      return { ok: false, entry: null, reason: reply.code }
    }
    if (reply.op !== 'list') {
      return { ok: false, entry: null, reason: 'unexpected reply' }
    }
    const entry = reply.jobs.find(j => j.short === short) ?? null
    return { ok: true, entry, reason: entry ? 'live' : 'not in roster' }
  } catch (e) {
    return { ok: false, entry: null, reason: String(e) }
  }
}

// ──: the CREW-LIVENESS facet for the critter's awake
//  predicate. Operator ruling: long-lived daemon workers (the scribe /
//  implementer teammates and their party spawns) count as ACTIVE AGENTS.
//  The daemon runs out of process, so there is no in-process push edge for
//  its roster — the honest read is the daemonSnapshot idiom: a SYNC accessor
//  over a module TTL cache, with a stale read kicking ONE fire-and-forget
//  `list` RPC for the next consumer. No timer, no polling loop of its own:
//  it refreshes only as often as something actually reads it (critterSleep's
//  recompute rides the shared 30s bucket).
// ─────────────────────────────────────────────────────────────────────────

export type DaemonCrewLiveness = {
  /** A daemon supervisor is present (record + pid — the sync probe). */
  engaged: boolean
  /** At least one roster entry is still LIVE (no settled outcome). */
  workersActive: boolean
}

const CREW_TTL_MS = 30_000
/** This process's session id, throw-safe (the sleep verdict must never
 *  break on an unbooted identity). */
function getSessionIdSafe(): string | null {
  try {
    return getSessionId()
  } catch {
    return null
  }
}

let crewVerdict: { workersActive: boolean; at: number } | null = null
let crewRefreshInFlight = false
let crewProofOverride: DaemonCrewLiveness | null = null

function kickCrewRefresh(): void {
  if (crewRefreshInFlight) return
  crewRefreshInFlight = true
  void daemonRosterList()
    .then(r => {
      // The protocol's own liveness word: `outcome` is filled once a run
      // settled — missing means the worker is still live. THIS SESSION is
      // never "a live worker" to itself (FC-064): the roster carries the
      // operator's own chat, so a session alone on the box kept its own
      // sleep verdict unreachable — the mascot held the awake cadence and
      // burned ~120ms CPU per wall second for ever.
      const ownSessionId = getSessionIdSafe()
      crewVerdict = {
        workersActive:
          r.ok && r.entries.some(j => j.outcome === undefined && j.sessionId !== ownSessionId),
        at: Date.now(),
      }
    })
    .catch(() => {
      crewVerdict = { workersActive: false, at: Date.now() }
    })
    .finally(() => {
      crewRefreshInFlight = false
    })
}

/**
 * SYNC crew liveness for the per-recompute path. No supervisor record ⇒
 * `{engaged:false, workersActive:false}` without touching the socket; a
 * present supervisor serves the TTL-cached roster verdict and refreshes it
 * in the background when stale. Never throws, never blocks.
 */
export function daemonCrewLivenessSync(): DaemonCrewLiveness {
  if (crewProofOverride) return crewProofOverride
  if (daemonSnapshot().state === 'off') {
    return { engaged: false, workersActive: false }
  }
  if (!crewVerdict || Date.now() - crewVerdict.at >= CREW_TTL_MS) kickCrewRefresh()
  return { engaged: true, workersActive: crewVerdict?.workersActive ?? false }
}

/** Proof seam: pin the verdict (the RPC boundary is out-of-process — the
 *  prover cannot spawn a daemon; the REAL path keeps a source lock in
 * prove-critter-sleep). null restores the live derivation. */
export function primeDaemonCrewLivenessForProofs(v: DaemonCrewLiveness | null): void {
  crewProofOverride = v
}

export type RosterListSnapshot = {
  /** True iff a daemon answered the list RPC. */
  ok: boolean
  /** Every wire entry the daemon listed (optionally filtered to `shorts`). */
  entries: WireRosterEntry[]
  /** One-line human reason ('live' | an error code). */
  reason: string
}

/**
 * Read the WHOLE roster (router-party P6): the wire already carries every
 * entry (protocol.ts `list` reply) — the single-entry daemonRosterSnapshot
 * above just .find()s one. Multi-seat consumers (the /party board's live
 * cross-check, the cockpit party section) read the list in ONE RPC instead of
 * five. Optional `shorts` filter. Never throws; degrades honestly.
 */
export async function daemonRosterList(
  shorts?: readonly string[],
): Promise<RosterListSnapshot> {
  try {
    const reply = await daemonControlRpc({ op: 'list' } as DaemonRequest)
    if (!reply.ok) {
      return { ok: false, entries: [], reason: reply.code }
    }
    if (reply.op !== 'list') {
      return { ok: false, entries: [], reason: 'unexpected reply' }
    }
    const entries = shorts
      ? reply.jobs.filter(j => shorts.includes(j.short))
      : [...reply.jobs]
    return { ok: true, entries, reason: 'live' }
  } catch (e) {
    return { ok: false, entries: [], reason: String(e) }
  }
}
