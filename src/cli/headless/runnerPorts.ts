import type { Command } from '../../commands.js'
import type { RunnerQuiescence } from '../../daemon/runnerQuiescence.js'
import type { RowDraft, RowScope } from '../../rows/project.js'
import type { InputRow } from '../../rows/vocabulary.js'
import type { Peer } from '../../runner/wire/peer.js'
import type { MCPServerConnection, ScopedMcpServerConfig } from '../../services/mcp/types.js'
import type { AppState } from '../../state/AppStateStore.js'
import type { ToolUseContext } from '../../Tool.js'
import type { Message } from '../../types/message.js'
import type { FileStateCache } from '../../utils/fileStateCache.js'
import type { runSessionStartHooks } from '../../utils/sessionStart.js'
import type { ThinkingConfig } from '../../utils/thinking.js'
import { createContentReplacementState, type ContentReplacementState } from '../../utils/toolResultStorage.js'
import type { StructuredIO } from '../structuredIO.js'
import type { AskHost } from './runnerAsks.js'
import type { TurnDriver } from './turnDriver.js'

export type HeadlessOptions = {
  continue?: boolean
  resume?: string | boolean
  resumeSessionAt?: string
  outputFormat?: string
  syntaxInput?: string
  jsonSchema?: Record<string, unknown>
  allowedTools?: string[]
  thinkingConfig?: ThinkingConfig
  maxTurns?: number
  maxBudgetUsd?: number
  maxTimeMs?: number
  systemPrompt?: string
  defaultBrief?: true
  appendSystemPrompt?: string
  hostAppendSystemPrompt?: string
  userSpecifiedModel?: string
  fallbackModel?: string
  includePartialMessages?: boolean
  forkSession?: boolean
  rewindFiles?: string
  agent?: string
  workload?: string
  advise?: boolean
  bootSessionIdPinned?: boolean
  title?: string
  initializeMcp?: () => Promise<void>
  door?: 'rows' | 'wire'
  subscribeAppState?: (listener: () => void) => () => void
  sessionStartHooksPromise?: ReturnType<typeof runSessionStartHooks>
  setSDKStatus?: unknown
}

export type RunnerState = {
  awaitingSessionClaim: boolean
  bootRefusalFact: string | null
  turnsRun: number
  currentTurnId: string | null
  resumeOf: string | undefined
  turnMessages: (() => readonly Message[]) | null
  contentReplacementState: ContentReplacementState
  mcpInitialized: boolean
  claimSettling: Promise<void> | null
  sessionFactsHoldSpent: boolean
  sessionFactsHold: Promise<void> | null
  runnerRestartReason: string | undefined
  recoveredCommandIds: string[]
  activeModel: string | undefined
  activeCommands: Command[]
  inputClosed: boolean
  inFlightAbort: AbortController | null
  leaveAbort: AbortController | null
  heldSeatModel: { requestId: number; model: string; words?: string } | null
  heldSeatEffort: { requestId: number; effort: string } | null
  deferredSpawnSwitches: Array<{ kind: 'subagents'; on: boolean; requestId: number }>
}

export function createRunnerState(): RunnerState {
  return {
    awaitingSessionClaim: false,
    bootRefusalFact: null,
    turnsRun: 0,
    currentTurnId: null,
    resumeOf: undefined,
    turnMessages: null,
    contentReplacementState: createContentReplacementState(),
    mcpInitialized: false,
    claimSettling: null,
    sessionFactsHoldSpent: false,
    sessionFactsHold: null,
    runnerRestartReason: undefined,
    recoveredCommandIds: [],
    activeModel: undefined,
    activeCommands: [],
    inputClosed: false,
    inFlightAbort: null,
    leaveAbort: null,
    heldSeatModel: null,
    heldSeatEffort: null,
    deferredSpawnSwitches: [],
  }
}

export type RunnerPorts = {
  live: RunnerState
  options: HeadlessOptions
  wire: boolean
  io: StructuredIO
  peer: Peer | null
  asks: AskHost
  driver: TurnDriver
  messages: Message[]
  getAppState: () => AppState
  setAppState: (updater: (previous: AppState) => AppState) => void
  canUseTool: ReturnType<AskHost['createCanUseTool']>
  enqueueRow: (row: RowDraft) => void
  liveScope: () => RowScope
  acceptInputRow: (row: InputRow) => Promise<{ accepted: true } | { accepted: false; reason: 'duplicate' }>
  heldNoticeWaits: () => boolean
  interruptOutcomes: Map<string, boolean>
  quiescence: RunnerQuiescence
  relaunchContext: () => Promise<ToolUseContext>
  checkBuildBehind: (now?: boolean) => Promise<void>
  getReadFileCache: () => FileStateCache
  applySeatModel: (model: string, words?: string) => Promise<void>
  applySeatEffort: (effort: string) => void
  landSpawnSwitch: (kind: 'subagents', on: boolean) => void
  settleSessionBriefs: (kept: { brief?: string; briefAdd?: string }, record: boolean) => void
  armSessionRunnerWiring: (sid: string) => Promise<void>
  hydrateResumedRun: () => Promise<void>
  persistBootModelRefusal: (refusal: string) => Promise<void>
  settleClearBirth: () => void
  releaseQueueUntilClaimed: (() => void) | null
  missionGuard: typeof import('../../guards/mission.js')
  liveMcp: ReturnType<typeof import('../../services/mcp/liveConfig.js').watchLiveMcpConfig>
  mcpSignIns: Map<string, { controller: AbortController; authorizationUrl?: string }>
  elicitationRegistered: Set<string>
  permittedMcpConfig: (name: string) => Promise<ScopedMcpServerConfig | null>
  serializeMcpChange: <T>(operation: () => Promise<T>) => Promise<T>
  reconnectLiveMcp: (name: string, config: ScopedMcpServerConfig) => Promise<MCPServerConnection>
  resolveServerConfigFromAllSources: (serverName: string) => ScopedMcpServerConfig | null
  applyReconnectedClient: (serverName: string, client: MCPServerConnection) => Promise<void>
  registerPerTurnHandlers: (clients: MCPServerConnection[]) => void
  isLocalShellTask: (task: unknown) => boolean
  killTask: (taskId: string, setAppState: RunnerPorts['setAppState']) => Promise<unknown>
  requestShellBackground: () => number
}
