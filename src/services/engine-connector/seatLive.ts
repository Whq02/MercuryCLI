import type { EditOutcomeRowV1, EngineConnectorV1 } from './types.js'
import type { WorkCountsV1 } from './workCounts.js'
import type { StreamingTailStore } from '../../utils/messages/streamingTailStore.js'
import type { RequestWaitV1 } from '../providers/streamIdleBudget.js'
import type { FoldStatusV1 } from '../compact/foldStatus.js'
import type { RunnerStateFactV1 } from './seatProjections.js'

export interface SessionLiveV1 {
  inFlight: boolean
  phase: 'thinking' | 'tool' | 'responding' | 'compacting' | 'waiting' | 'idle'
  agentsWaiting: number
  waitingOn?: WorkCountsV1
  inProgressToolUseIDs: Set<string>
  turnStartedAtMs: number | null
}

export interface SeatStatusV1 {
  title: string
  projectLabel: string
  interrupting: boolean
  hardStopping: boolean
  wait: RequestWaitV1 | null
  quietMs: number | null
  watchdogMs: number | null
  phaseMs: number | null
  toolBudgetMs: number | null
  stuck: boolean
  isolation?: 'exclusive' | 'shared' | 'worktree-isolated' | 'read-only'
  branchLabel?: string
  runner?: RunnerStateFactV1 | null
}

export type LostLineV1 = { text: string; atMs: number }

export interface LiveTurnFactsV1 {
  replyChars: number
  thinkingChars: number
  thinkingBlocks?: number
  wireOutputTokens: number | null
  firstByteAtMs: number | null
  lastByteAtMs?: number | null
  wait: RequestWaitV1 | null
}

export const IDLE_TURN_FACTS: LiveTurnFactsV1 = Object.freeze({
  replyChars: 0,
  thinkingChars: 0,
  wireOutputTokens: null,
  firstByteAtMs: null,
  wait: null,
}) as LiveTurnFactsV1

export interface SeatLiveExtensionV1 {
  live(): SessionLiveV1
  subscribeLive(listener: () => void): () => void
  status(): SeatStatusV1
  tail(): StreamingTailStore
  tailAnchor?(): number
  turnChars?(): number
  turnOutputTokens?(): number | null
  turnFacts?(): LiveTurnFactsV1
  fold?(): FoldStatusV1 | null
  subscribeFold?(listener: () => void): () => void
  lostLine?(): LostLineV1 | null
  editOutcomes?(): EditOutcomeRowV1[] | null
}

export function hasSeatLive(
  connector: EngineConnectorV1,
): connector is EngineConnectorV1 & SeatLiveExtensionV1 {
  const c = connector as Partial<SeatLiveExtensionV1>
  return typeof c.live === 'function' && typeof c.subscribeLive === 'function' && typeof c.status === 'function' && typeof c.tail === 'function'
}

export const IDLE_LIVE: SessionLiveV1 = Object.freeze({
  inFlight: false,
  phase: 'idle',
  agentsWaiting: 0,
  inProgressToolUseIDs: new Set<string>(),
  turnStartedAtMs: null,
}) as SessionLiveV1
