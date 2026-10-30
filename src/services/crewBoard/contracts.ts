import type * as React from 'react'
import type { Tool, ToolUseContext } from '../../Tool.js'

type BoardKind = 'ask' | 'answer' | 'blocker' | 'result' | 'message' | 'notice'
type BoardAuthor = { sessionId: string; agentId: string; executionId: string }
type BoardRef = { uri: string; digest: string }
export type BoardPost = {
  clientOpId: string
  kind: BoardKind
  text: string
  threadId?: string
  replyTo?: string
  taskId?: string
  mentions?: string[]
  relatedTasks?: string[]
  files?: string[]
  refs?: BoardRef[]
}
export type BoardEvent = Required<Omit<BoardPost, 'threadId' | 'replyTo' | 'taskId'>> & {
  schema: 1
  boardId: string
  waveId: string
  seq: number
  eventId: string
  author: BoardAuthor
  authorName?: string
  createdAt: string
  payloadDigest: string
  threadId: string
  replyTo?: string
  taskId?: string
  policyRevision: 1
}
export type BoardRead = { since?: number; snapshot?: number; thread?: string; task?: string; mentions?: string; files?: string[]; limitTokens?: number; acknowledge?: string[]; watch?: boolean }
export type BoardPacket = { events: BoardEvent[]; snapshot: number; cursor: number; omitted: number; tokens: number; packetId?: string; reason?: string }
export type BoardReceipt = { ok: true; eventId: string; seq: number; replay: boolean } | { ok: false; reason: string; retryAfter?: number }
export type BoardViewSnapshot = { on: boolean; events: BoardEvent[]; snapshot: number; omitted: number; later?: number; admitted: number; appearances?: number; peerTurns: 0; record?: { path: string; sessionId: string }; error?: string }
export type BoardPrincipal = { author: BoardAuthor; name: string }
export type BoardHost = {
  buildTool: typeof import('../../Tool.js').buildTool
  principal(context: ToolUseContext): BoardPrincipal | null
  paused(agentId: string): boolean
  sessionOn(): boolean
}
export interface BoardStore {
  enroll(principal: BoardPrincipal): void
  member(agentId: string): boolean
  post(principal: BoardPrincipal, post: BoardPost, delivery?: 'index' | 'body' | 'mirror'): BoardReceipt
  read(principal: BoardPrincipal, input: BoardRead): BoardPacket
  boundary(principal: BoardPrincipal, seen: ReadonlySet<string>): { text: string; eventIds: string[] } | null
  presented(principal: BoardPrincipal, eventIds: string[], requestId: string, readPackets?: string[]): void
  view(before?: number, thread?: string): BoardViewSnapshot
  subscribe(listener: () => void): () => void
  close(): void
}
export type BoardModule = {
  open(path: string, sessionId: string): BoardStore
  tool(host: BoardHost, store: () => BoardStore | null): Tool
  view(host: { React: typeof React; Text: React.ComponentType<any>; Box: React.ComponentType<any>; useInput: (handler: (input: string, key: any) => void) => void; snapshot: BoardViewSnapshot; onBack: () => void; width: number; height: number }): React.ReactNode
  page(record: { path: string; sessionId: string }, before?: number, thread?: string): BoardViewSnapshot
}
