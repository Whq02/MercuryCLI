import type { EngineConnectorV1 } from './types.js'
import type { StreamingTailStore } from '../../utils/messages/streamingTailStore.js'

export interface SessionLiveV1 {
  inFlight: boolean
  phase: 'thinking' | 'tool' | 'responding' | 'compacting' | 'idle'
  inProgressToolUseIDs: Set<string>
  turnStartedAtMs: number | null
}

export interface SeatStatusV1 {
  title: string
  projectLabel: string
  interrupting: boolean
  quietMs: number | null
  watchdogMs: number | null
  phaseMs: number | null
  toolBudgetMs: number | null
  stuck: boolean
  isolation?: 'exclusive' | 'shared' | 'worktree-isolated' | 'read-only'
  branchLabel?: string
}

export interface SeatLiveExtensionV1 {
  live(): SessionLiveV1
  subscribeLive(listener: () => void): () => void
  status(): SeatStatusV1
  tail(): StreamingTailStore
  turnChars?(): number
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
  inProgressToolUseIDs: new Set<string>(),
  turnStartedAtMs: null,
}) as SessionLiveV1
