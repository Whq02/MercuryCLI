
import { getCrewName } from './crewmate.js'
import { readCrewFile } from './crew/crewHelpers.js'

export interface CommandSeat {
  room: string
  name: string
  posture: string
  reportsTo: string | null
  branch: string | null
  role: 'field-commander' | 'room-commander'
  actorId: string
  sessionId: string | null
  running: boolean
  model?: string
}

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
  instances: LadderInstance[]
}

interface LadderMember {
  agentId?: unknown
  name?: unknown
  model?: unknown
  worktreePath?: unknown
  sessionId?: unknown
  isActive?: unknown
  role?: unknown
}

const ROOT_INSTANCE = 'root'

function worktreeId(p: string | null): string | null {
  if (!p) return null
  const parts = p.split(/[\\/]/).filter(Boolean)
  return parts.length ? (parts[parts.length - 1] ?? null) : null
}

export function deriveCommandHierarchy(
  crewName: string,
  crew: {
    leadAgentId?: unknown
    leadSessionId?: unknown
    members?: unknown
  } | null,
): CommandHierarchy | null {
  if (!crew) return null

  const fcRoom = crewName
  const rows: CommandSeat[] = []
  const knownRooms: string[] = [fcRoom]

  const leadId =
    typeof crew.leadAgentId === 'string' ? crew.leadAgentId : 'crew-lead'
  rows.push({
    room: fcRoom,
    name: 'crew-lead',
    posture: 'commanding',
    reportsTo: null,
    branch: null,
    role: 'field-commander',
    actorId: leadId,
    sessionId:
      typeof crew.leadSessionId === 'string' ? crew.leadSessionId : null,
    running: true,
  })

  const members = Array.isArray(crew.members)
    ? (crew.members as LadderMember[])
    : []
  for (const m of members) {
    const name = typeof m.name === 'string' ? m.name : null
    if (!name || name === 'crew-lead') continue
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
      running: m.isActive !== false,
      model: typeof m.model === 'string' ? m.model : undefined,
    })
  }

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
          repoId: crewName,
          worktreeId: key === ROOT_INSTANCE ? null : key,
          rooms: instRooms,
        }))
      : [
          {
            key: ROOT_INSTANCE,
            repoId: crewName,
            worktreeId: null,
            rooms: [],
          },
        ]

  return { fcRoom, knownRooms, rows, instances }
}

export async function fetchCommandHierarchy(): Promise<CommandHierarchy | null> {
  try {
    const crewName = getCrewName()
    if (!crewName) return null
    const crew = readCrewFile(crewName)
    return deriveCommandHierarchy(crewName, crew)
  } catch {
    return null
  }
}
