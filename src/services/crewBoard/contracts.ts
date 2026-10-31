import type * as React from 'react'
import type { Tool, ToolUseContext } from '../../Tool.js'

export type BoardLimits = Readonly<{ seatAllowance: number; waveAllowance: number; postsPerMinute: number; postsPerSeat: number; postChars: number }>
export const DEFAULT_BOARD_LIMITS: BoardLimits = Object.freeze({ seatAllowance: 0, waveAllowance: 0, postsPerMinute: 4, postsPerSeat: 120, postChars: 0 })

type BoardKind = 'ask' | 'answer' | 'blocker' | 'result' | 'correction' | 'message' | 'notice'
type BoardAuthor = { sessionId: string; agentId: string; executionId: string }
type BoardRef = { uri: string; digest: string }
export type BoardPost = {
  clientOpId: string
  kind: BoardKind
  text: string
  threadId?: string
  replyTo?: string
  corrects?: string
  taskId?: string
  about?: string
  mentions?: string[]
  to?: string[]
  relatedTasks?: string[]
  files?: string[]
  refs?: BoardRef[]
}
export type BoardEvent = Omit<BoardPost, 'mentions' | 'to' | 'relatedTasks' | 'files' | 'refs'> & {
  schema: 1
  boardId: string
  waveId: string
  seq: number
  eventId: string
  author: BoardAuthor
  authorName?: string
  team?: string
  mentions: string[]
  unknownMentions?: string[]
  relatedTasks: string[]
  files: string[]
  refs: BoardRef[]
  createdAt: string
  payloadDigest: string
  threadId: string
  policyRevision: 1
}
export type BoardRead = { since?: number; snapshot?: number; thread?: string; task?: string; mentions?: string; team?: string; files?: string[]; limitTokens?: number; acknowledge?: string[]; watch?: boolean }
export type BoardPacket = { events: (BoardEvent | { eventId: string; seq: number; text: string; truncated: true })[]; snapshot: number; cursor: number; omitted: number; tokens: number; skippedSeen: number; reread: string; packetId?: string; reason?: string }
export type BoardReceipt = { ok: true; eventId: string; seq: number; replay: boolean; unknownMentions?: string[] } | { ok: false; reason: string; retryAfter?: number; cap?: 'thread-rounds' }
export type BoardViewSnapshot = { on: boolean; events: BoardEvent[]; teams?: string[]; names?: string[]; duplicateMinutes?: string[]; snapshot: number; omitted: number; later?: number; admitted: number; appearances?: number; uncapped?: boolean; peerTurns: 0; record?: { path: string; sessionId: string }; error?: string }
export type BoardPrincipal = { author: BoardAuthor; name: string; team?: string }
export type BoardHost = {
  buildTool: typeof import('../../Tool.js').buildTool
  principal(context: ToolUseContext): BoardPrincipal | null
  paused(agentId: string): boolean
  sessionOn(): boolean
}
export interface BoardStore {
  readonly limits: BoardLimits
  readonly uncapped: boolean
  setUncapped(principal: BoardPrincipal, value: boolean): void
  settle(principal: BoardPrincipal): void
  enroll(principal: BoardPrincipal): void
  member(agentId: string): boolean
  assignTeam(principal: BoardPrincipal, seat: string, team: string): { ok: boolean; reason?: string; name?: string; team?: string }
  post(principal: BoardPrincipal, post: BoardPost, delivery?: 'index' | 'body' | 'mirror'): BoardReceipt
  read(principal: BoardPrincipal, input: BoardRead): BoardPacket
  leadMention(): BoardEvent | null
  leadPosts(since: number): BoardEvent[]
  leadPainted(): number
  markLeadPainted(seq: number): void
  boundary(principal: BoardPrincipal, seen: ReadonlySet<string>): { text: string; eventIds: string[] } | null
  presented(principal: BoardPrincipal, eventIds: string[], requestId: string, readPackets?: string[]): void
  view(before?: number, thread?: string, team?: string): BoardViewSnapshot
  subscribe(listener: () => void): () => void
  close(): void
}
export type BoardModule = {
  open(path: string, sessionId: string, limits?: BoardLimits): BoardStore
  tool(host: BoardHost, store: () => BoardStore | null): Tool
  view(host: { React: typeof React; Text: React.ComponentType<any>; Box: React.ComponentType<any>; tokens: import('../../utils/mercuryTokens.js').MercuryThemeTokens; wrapText: typeof import('../../ink.js').wrapText; useInput: (handler: (input: string, key: any, event: { stopImmediatePropagation(): void }) => void) => void; snapshot: BoardViewSnapshot; traffic?: { key: string; at: string; agent: string; dir: 'to' | 'from'; via: 'launch' | 'message' | 'reply'; text: string }[]; onBack: () => void; width: number; height: number }): React.ReactNode
  page(record: { path: string; sessionId: string }, before?: number, thread?: string, team?: string): BoardViewSnapshot
  tail(record: { path: string; sessionId: string }): Pick<BoardStore, 'view' | 'subscribe' | 'close'>
}
