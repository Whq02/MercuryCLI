import { getSessionId } from '../../bootstrap/state.js'
import { daemonControlRpc } from '../../daemon/controlSocket.js'
import type { DaemonRequest, WireRosterEntry } from '../../daemon/protocol.js'
import { daemonSnapshot } from './daemonSnapshot.js'

export type RosterSnapshot = {
  ok: boolean
  entry: WireRosterEntry | null
  reason: string
}

export async function daemonRosterSnapshot(short: string): Promise<RosterSnapshot> {
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


export type DaemonCrewLiveness = {
  engaged: boolean
  workersActive: boolean
}

const CREW_TTL_MS = 30_000
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

export function daemonCrewLivenessSync(): DaemonCrewLiveness {
  if (crewProofOverride) return crewProofOverride
  if (daemonSnapshot().state === 'off') {
    return { engaged: false, workersActive: false }
  }
  if (!crewVerdict || Date.now() - crewVerdict.at >= CREW_TTL_MS) kickCrewRefresh()
  return { engaged: true, workersActive: crewVerdict?.workersActive ?? false }
}

export function primeDaemonCrewLivenessForProofs(v: DaemonCrewLiveness | null): void {
  crewProofOverride = v
}

export type RosterListSnapshot = {
  ok: boolean
  entries: WireRosterEntry[]
  reason: string
}

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
