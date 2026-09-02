// ============================================================================
//  commandHierarchy — the command-ladder derivation + types.
//
//  The GET /api/command-hierarchy fetcher. The serving build is a browser surface that
//  reads the ladder forest off a running server (deriveLadderForest). Mercury has
//  no such server — so this leaf derives the SAME structure HONESTLY from the
//  local team file (`<teams root>/<team>/config.json` — the MERCURY_TEAMS_DIR
//  resolver — via readTeamFile), the one
//  authoritative on-disk record of who is seated under whom.
//
//  The mapping (server → local) is faithful to the ladder's meaning:
//    field-commander  ← the team LEAD (leadAgentId / leadSessionId)
//    room-commander   ← every other team MEMBER (its bound session is its commander)
//    reportsTo forest ← every room-commander reports to the field-commander room
//                       (today's single-FC forest; multi-FC is forward-defensive)
//    instances        ← members grouped by their (repoId=team, worktreeId) key —
//                       the WS9 multi-repo-fleet grouping that powers the realm picker
//    running          ← the supervisor child-alive signal (member.isActive) — NOT a
//                       live-chrome claim; live gating still belongs to the heartbeat
//                       (the ghost-LIVE rule). Absent team / absent file ⇒ null, the
//                       same "no data" contract the original fetcher returns on !ok.
//
//  Kept framework-agnostic (zero React, zero DOM, zero fetch). Every read fails OPEN to null — a missing source is
// a state, not a crash.
// ============================================================================

import { getTeamName } from './teammate.js'
import { readTeamFile } from './swarm/teamHelpers.js'

/** One seat of the derived command ladder: the room, its role under the
 *  reportsTo forest (the FC room seats the field-commander; every other room's
 *  bound session is its room-commander), the bound session id (room-map) and
 *  the supervisor-mirror running state. `running` is the SUPERVISOR's
 *  child-alive signal — live-chrome still gates on the bridge heartbeat (the
 *  ghost-LIVE rule). */
export interface CommandSeat {
  room: string
  name: string
  posture: string
  reportsTo: string | null
  /** The room's declared lane (room.json branch / member worktree) — the
 *  room→worktree map edge. */
  branch: string | null
  role: 'field-commander' | 'room-commander'
  actorId: string
  sessionId: string | null
  running: boolean
  model?: string
}

/** One repo/worktree INSTANCE of the ladder forest (WS9 multi-repo fleets): the
 *  seats grouped by their (repoId, worktreeId) key. Unstamped flat seats land in
 *  the 'root' instance (today's single-instance view IS root). */
export interface InstanceRoom {
  room: string
  role: string
  actorId: string
  sessionId: string | null
}

export interface LadderInstance {
  key: string
  repoId: string | null
  worktreeId: string | null
  rooms: InstanceRoom[]
}

export interface CommandHierarchy {
  fcRoom: string | null
  knownRooms: string[]
  rows: CommandSeat[]
  /** The repo/worktree instance forest (≥1; a single 'root' instance until
 *  multi-repo fleets run keyed sessions). Forward-defensive: the UI groups by
 *  instance only when length > 1. */
  instances: LadderInstance[]
}

/** The on-disk team member shape we read (a structural subset of TeamFile's
 *  member — kept local so this leaf does not depend on swarm internals beyond
 *  readTeamFile's return). */
interface LadderMember {
  agentId?: unknown
  name?: unknown
  model?: unknown
  worktreePath?: unknown
  sessionId?: unknown
  isActive?: unknown
  role?: unknown
}

/** The 'root' instance key — the single-instance view when no member carries a
 *  distinct worktree (today's flat ladder IS root). */
const ROOT_INSTANCE = 'root'

/** Last path segment of a worktree dir — the human worktree id (forest key). */
function worktreeId(p: string | null): string | null {
  if (!p) return null
  const parts = p.split(/[\\/]/).filter(Boolean)
  return parts.length ? (parts[parts.length - 1] ?? null) : null
}

/** Derive the local command ladder for a given team file. Pure given its input
 *  (the readTeamFile result); exported so it can be unit-tested without IO. */
export function deriveCommandHierarchy(
  teamName: string,
  team: {
    leadAgentId?: unknown
    leadSessionId?: unknown
    members?: unknown
  } | null,
): CommandHierarchy | null {
  if (!team) return null

  const fcRoom = teamName
  const rows: CommandSeat[] = []
  const knownRooms: string[] = [fcRoom]

  // The field-commander seat: the team lead. Its room is the team room; its
  // bound session is the lead session (when discovery has recorded one).
  const leadId =
    typeof team.leadAgentId === 'string' ? team.leadAgentId : 'team-lead'
  rows.push({
    room: fcRoom,
    name: 'team-lead',
    posture: 'commanding',
    reportsTo: null,
    branch: null,
    role: 'field-commander',
    actorId: leadId,
    sessionId:
      typeof team.leadSessionId === 'string' ? team.leadSessionId : null,
    running: true,
  })

  // Each member is a room-commander reporting up to the field-commander room.
  const members = Array.isArray(team.members)
    ? (team.members as LadderMember[])
    : []
  for (const m of members) {
    const name = typeof m.name === 'string' ? m.name : null
    if (!name || name === 'team-lead') continue // the lead is already the FC seat
    const actorId = typeof m.agentId === 'string' ? m.agentId : name
    const wt = typeof m.worktreePath === 'string' ? m.worktreePath : null
    knownRooms.push(name)
    rows.push({
      room: name,
      name,
      posture: typeof m.role === 'string' ? m.role : 'standing',
      reportsTo: fcRoom,
      branch: worktreeId(wt),
      role: 'room-commander',
      actorId,
      sessionId: typeof m.sessionId === 'string' ? m.sessionId : null,
      // The supervisor child-alive signal: a member is "running" unless it has
      // been flagged idle (isActive === false). Absent flag ⇒ active (the team
      // file's own default). NOT a live-chrome claim — heartbeat still gates.
      running: m.isActive !== false,
      model: typeof m.model === 'string' ? m.model : undefined,
    })
  }

  // Instance forest (WS9 multi-repo fleets): group room-commanders by their
  // worktree id. When no member carries a distinct worktree the whole ladder is
  // a single 'root' instance — exactly the single-instance view. The UI groups
  // by instance only when length > 1, so a flat team stays flat.
  const byKey = new Map<string, InstanceRoom[]>()
  for (const r of rows) {
    if (r.role !== 'room-commander') continue
    const key = r.branch ?? ROOT_INSTANCE
    const list = byKey.get(key) ?? []
    list.push({
      room: r.room,
      role: r.role,
      actorId: r.actorId,
      sessionId: r.sessionId,
    })
    byKey.set(key, list)
  }
  const instances: LadderInstance[] =
    byKey.size > 0
      ? Array.from(byKey.entries()).map(([key, instRooms]) => ({
          key,
          repoId: teamName,
          worktreeId: key === ROOT_INSTANCE ? null : key,
          rooms: instRooms,
        }))
      : [
          {
            key: ROOT_INSTANCE,
            repoId: teamName,
            worktreeId: null,
            rooms: [],
          },
        ]

  return { fcRoom, knownRooms, rows, instances }
}

/** Fetch the command ladder for the current session's team. HONEST fork-local
 *  derivation (Mercury has no command-hierarchy server): reads the team file
 *  and folds the lead + members into the seat forest. Returns null when not in a
 *  team or the file is unreadable — the same "no data" contract the serving
 *  fetcher returns on a non-ok / non-array response. Fails OPEN: any throw ⇒
 *  null, never a crash. Async to match the original signature (so a future
 *  server-backed source can drop in without changing call sites). */
export async function fetchCommandHierarchy(): Promise<CommandHierarchy | null> {
  try {
    const teamName = getTeamName()
    if (!teamName) return null
    const team = readTeamFile(teamName)
    return deriveCommandHierarchy(teamName, team)
  } catch {
    return null
  }
}
