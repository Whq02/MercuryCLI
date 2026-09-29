import type { CrewAgentFacts, CrewAgentState } from '../engine-connector/crewFacts.js'
import { decodeAgentPause } from '../../tasks/LocalAgentTask/agentPause.js'

export type CrewRosterKind = 'crewmate' | 'seat'

export type CrewRosterRunner =
  | { kind: 'session'; sessionId: string | null; taskId: string }
  | { kind: 'daemon'; short: string; pid: number | null }

export interface CrewRosterRecordV1 {
  id: string
  name: string
  kind: CrewRosterKind
  model: string | null
  cwd: string | null
  worktree: string | null
  state: CrewAgentState
  runner: CrewRosterRunner
  startedAt: number
  lastActiveAt: number | null
  facts: CrewAgentFacts
}

export interface CrewSeatGlanceV1 {
  name: string
  model?: string
  online: boolean
  unread: number
  busy?: boolean
  pid?: number
  startedAt?: number
  joinedAt?: number
  turnStartedAt?: number
  cwd?: string
  worktree?: string
  paused?: { why: string; words: string; resumesAtMs?: number }
}

export const CREW_SEAT_ID_PREFIX = 'seat:'

export function crewSeatId(name: string): string {
  return `${CREW_SEAT_ID_PREFIX}${name}`
}

export function isCrewSeatId(id: string): boolean {
  return id.startsWith(CREW_SEAT_ID_PREFIX)
}

export const CREW_SEAT_BUSY_WORD = 'busy'
export const CREW_SEAT_ONLINE_WORD = 'online'
export const CREW_SEAT_OFFLINE_WORD = 'offline'
export const CREW_SEAT_PAUSED_WORD = 'paused'

export function seatFactsOf(seat: CrewSeatGlanceV1): CrewAgentFacts {
  const live = seat.online
  const paused = live ? decodeAgentPause(seat.paused) : null
  const busy = live && paused === null && seat.busy === true
  const startedAt = seat.startedAt ?? seat.joinedAt ?? 0
  return {
    id: crewSeatId(seat.name),
    name: seat.name,
    kind: 'named',
    status: paused !== null ? CREW_SEAT_PAUSED_WORD : busy ? CREW_SEAT_BUSY_WORD : live ? CREW_SEAT_ONLINE_WORD : CREW_SEAT_OFFLINE_WORD,
    state: paused !== null ? 'paused' : busy ? 'running' : live ? 'idle' : 'stopped',
    running: live && paused === null,
    model: typeof seat.model === 'string' && seat.model !== '' ? seat.model : null,
    tokens: null,
    costUSD: null,
    unpricedTurns: 0,
    toolUses: null,
    activity: null,
    wait: null,
    toolUseId: null,
    startedAt,
    endedAt: live ? null : startedAt,
    agentType: null,
    crew: 'crew',
    effort: null,
    transcriptAgentId: null,
    description: null,
    error: null,
    stopReason: null,
    phase: null,
    paused,
    pendingAsks: 0,
    unreadNotices: seat.unread > 0 ? Math.floor(seat.unread) : 0,
    sessionId: null,
    cwd: typeof seat.cwd === 'string' && seat.cwd !== '' ? seat.cwd : null,
    worktree: typeof seat.worktree === 'string' && seat.worktree !== '' ? seat.worktree : null,
  }
}

function lastActiveOf(facts: CrewAgentFacts): number | null {
  if (facts.phase !== null && typeof facts.phase.sinceMs === 'number') return facts.phase.sinceMs
  return facts.endedAt
}

export function crewmateRecordOf(facts: CrewAgentFacts): CrewRosterRecordV1 {
  return {
    id: facts.id,
    name: facts.name,
    kind: 'crewmate',
    model: facts.model,
    cwd: facts.cwd,
    worktree: facts.worktree,
    state: facts.state,
    runner: { kind: 'session', sessionId: facts.sessionId, taskId: facts.id },
    startedAt: facts.startedAt,
    lastActiveAt: lastActiveOf(facts),
    facts,
  }
}

export function seatRecordOf(seat: CrewSeatGlanceV1): CrewRosterRecordV1 {
  const facts = seatFactsOf(seat)
  return {
    id: facts.id,
    name: seat.name,
    kind: 'seat',
    model: facts.model,
    cwd: facts.cwd,
    worktree: facts.worktree,
    state: facts.state,
    runner: { kind: 'daemon', short: seat.name, pid: seat.online && typeof seat.pid === 'number' ? seat.pid : null },
    startedAt: facts.startedAt,
    lastActiveAt: typeof seat.turnStartedAt === 'number' ? seat.turnStartedAt : facts.endedAt,
    facts,
  }
}

export function crewRosterOrder(a: CrewRosterRecordV1, b: CrewRosterRecordV1): number {
  if (a.facts.running !== b.facts.running) return a.facts.running ? -1 : 1
  return b.startedAt - a.startedAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
}

export function crewRosterOf(
  session: readonly CrewAgentFacts[],
  seats: readonly CrewSeatGlanceV1[] | null | undefined,
): CrewRosterRecordV1[] {
  const records: CrewRosterRecordV1[] = session.map(crewmateRecordOf)
  for (const seat of seats ?? []) records.push(seatRecordOf(seat))
  records.sort(crewRosterOrder)
  return records
}

export function crewRosterBusy(records: readonly CrewRosterRecordV1[]): CrewRosterRecordV1[] {
  return records.filter(record => record.state === 'running')
}

export function crewRosterByName(records: readonly CrewRosterRecordV1[], name: string): CrewRosterRecordV1 | null {
  const bare = name.replace(/^@/, '')
  return records.find(record => record.name === bare) ?? null
}
