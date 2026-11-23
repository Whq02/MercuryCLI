import type { CrewChatLifecycle } from '../../../engine/message-shapes/message.js'
import type { BoardEvent, BoardPrincipal, BoardSeat, BoardStore } from '../contracts.js'
import type { createWakeState } from '../wakeState.js'

export type Database = {
  exec(sql: string): unknown
  prepare(sql: string): { all(...values: (string | number)[]): Record<string, unknown>[]; get(...values: (string | number)[]): Record<string, unknown> | null | undefined; run(...values: (string | number)[]): unknown }
  close(): void
}

export interface StoreContext {
  transaction: <T>(fn: () => T) => T
  checkPrincipal: (p: BoardPrincipal) => void
  db: Database
  wakes: ReturnType<typeof createWakeState>
  latest: () => number
  publish: () => void
  seats: () => BoardSeat[]
  member: (agent: string) => boolean
  store: BoardStore
  sessionId: string
  notice: (agent: string, subject: string, detail: string) => void
  appoint: (team: string, agent: string) => void
  canonicalTeam: (team: string) => string
  takeName: (name: string, agent: string) => boolean
  checkEnrollment: (agent: string, team: string | undefined, captain?: boolean) => void
  reinstate: (launches: string, ...agents: string[]) => boolean
  teamOf: (agent: string) => string | undefined
  succeed: (agent: string, team: string | undefined) => void
  lifecycleEvent: (p: BoardPrincipal, lifecycle: CrewChatLifecycle, text: string) => void
  roster: () => Record<string, unknown>[]
  captainId: (team: string | undefined) => string | undefined
  events: (rows: Record<string, unknown>[]) => BoardEvent[]
  resolveMentions: (names: string[]) => { mentions: string[]; unknownMentions: string[] }
  now: () => number
  boardId: string
  waveId: string
  appendEvent: (event: BoardEvent) => void
  eventLabels: (team: string) => string[]
  readOnly: boolean
  packetText: (e: BoardEvent) => string
  markSeen: (agent: string, event: string) => void
  advance: (agent: string) => number
}
