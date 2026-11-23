import type { Command } from '../../commands/catalogue/commands.js'
import type { RunnerQuiescence } from '../runner-link/runnerQuiescence.js'
import type { RowDraft, RowScope } from '../../engine/rows/project.js'
import type { CompactionRow, InputRow, OutcomeRow, Row } from '../../engine/rows/vocabulary.js'
import type { AnthropicLimits } from '../../models/roads/anthropic/anthropicLimits.js'
import type { NoticeRecord } from '../../sessions/notices/unreadLedger.js'
import type { Peer } from '../runner-wire/peer.js'
import type { ConnectedMCPServer, MCPServerConnection, ScopedMcpServerConfig } from '../../integrations/mcp-shapes/mcpServerRecords.js'
import type { AppState } from '../../screen/app-state/AppStateStore.js'
import type { Tool, ToolUseContext } from '../../tools/kit/tool.js'
import type { Message } from '../../engine/message-shapes/message.js'
import type { PermissionMode } from '../../permissions/rules/permissions.js'
import { createFileStateCacheWithSizeLimit, READ_FILE_STATE_CACHE_SIZE, type FileStateCache } from '../../platform/files/fileStateCache.js'
import type { runSessionStartHooks } from './sessionStart.js'
import type { ThinkingConfig } from '../../models/effort/thinking.js'
import { createContentReplacementState, type ContentReplacementState } from '../../engine/tool-dispatch/toolResultStorage.js'
import type { OutboundLine, StructuredIO } from './structuredIO.js'
import type { AdvisorQuiet, AdvisorRoad } from '../../models/advisor/index.js'
import type { RequestWaitV1 } from '../../models/roads/streamIdleBudget.js'
import type { Capabilities } from '../runner-wire/methods.js'
import type { AgentDefinition } from '../../crew/agents/agentDefinition.js'
import type { HostAskLiveness } from './hostAskLiveness.js'
import type { AskHost } from './runnerAsks.js'
import { DEFAULT_CAPABILITIES } from './runnerMethods.js'
import type { TurnDriver } from './turnDriver.js'
import type { AcceptedInput, InputVerdict } from './inputDoor.js'
import type { ModelCatalogueEntry } from './boot/catalogueModels.js'
import type { QueuedCommand } from '../../screen/composer/input-core/textInput.js'
import type { ContentBlockParam } from '../../engine/message-shapes/wire.js'

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

type RunnerState = {
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
  heldSeatModel: { requestId: number; model: string; words?: string; replacedDefault?: string } | null
  heldSeatEffort: { requestId: number; effort: string } | null
  deferredSpawnSwitches: Array<{ kind: 'subagents'; on: boolean; requestId: number }>
  lastOutcome: OutcomeRow | null
  lastOutcomeWritten: Promise<unknown>
  signalCode: number | null
  sessionInitialized: boolean
  retiringQueuedCommands: boolean
  currentTurn: number | null
  sessionRowFor: string | null
  turnReachedModel: boolean
  turnAnchor: string | null
  lastAnswerSchemaKey: string | null
  hostAsks: HostAskLiveness | null
  deferredModelBreadcrumb: { to: string; from: string } | null
  deferredAdvisorQuiet: AdvisorQuiet[]
  capabilities: Capabilities
  activeAgents: AgentDefinition[]
  thinkingConfig: ThinkingConfig | undefined
  initializeJsonSchema: Record<string, unknown> | undefined
  bootModel: string | undefined
  bootModelRefusal: string | null
  openFold: { trigger: CompactionRow['trigger']; landing: boolean } | null
  mcpChangeChain: Promise<unknown>
  readFileCache: FileStateCache
  buildBehindSeen: string | null
  buildBehindCheckedAt: number
  buildBehindConfirm: ReturnType<typeof setTimeout> | null
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
    lastOutcome: null,
    lastOutcomeWritten: Promise.resolve(),
    signalCode: null,
    sessionInitialized: false,
    retiringQueuedCommands: false,
    currentTurn: null,
    sessionRowFor: null,
    turnReachedModel: false,
    turnAnchor: null,
    lastAnswerSchemaKey: null,
    hostAsks: null,
    deferredModelBreadcrumb: null,
    deferredAdvisorQuiet: [],
    capabilities: { ...DEFAULT_CAPABILITIES },
    activeAgents: [],
    thinkingConfig: undefined,
    initializeJsonSchema: undefined,
    bootModel: undefined,
    bootModelRefusal: null,
    openFold: null,
    mcpChangeChain: Promise.resolve(),
    readFileCache: createFileStateCacheWithSizeLimit(READ_FILE_STATE_CACHE_SIZE),
    buildBehindSeen: null,
    buildBehindCheckedAt: 0,
    buildBehindConfirm: null,
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
  noteOperatorMode: (mode: PermissionMode) => void
  tellStandingMode: () => void
  acceptInputRow: (row: InputRow) => Promise<{ accepted: true } | { accepted: false; reason: 'duplicate' }>
  heldNoticeWaits: () => boolean
  interruptOutcomes: Map<string, boolean>
  quiescence: RunnerQuiescence
  relaunchContext: () => Promise<ToolUseContext>
  checkBuildBehind: (now?: boolean) => Promise<void>
  getReadFileCache: () => FileStateCache
  applySeatModel: (model: string, words?: string, replacedDefault?: string) => Promise<void>
  applySeatEffort: (effort: string) => void
  landSpawnSwitch: (kind: 'subagents', on: boolean) => void
  settleSessionBriefs: (kept: { brief?: string; briefAdd?: string }, record: boolean) => void
  armSessionRunnerWiring: (sid: string) => Promise<void>
  hydrateResumedRun: () => Promise<void>
  persistBootModelRefusal: (refusal: string) => Promise<void>
  settleClearBirth: () => void
  releaseQueueUntilClaimed: (() => void) | null
  missionGuard: typeof import('../../permissions/guards/mission.js')
  liveMcp: ReturnType<typeof import('../../integrations/mcp/liveConfig.js').watchLiveMcpConfig>
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
  routeOutbound: (message: OutboundLine) => void
  streamingInput: boolean
  acceptInput: (input: AcceptedInput) => Promise<InputVerdict>
  receivedUuids: { add(value: string): void; has(value: string): boolean }
  missionLineOf: (content: string | ContentBlockParam[], cap: number) => string | null
  localCommandInput: (command: QueuedCommand) => boolean
  announcedNotifications: WeakSet<QueuedCommand>
  emitTaskNotificationFrames: (payloads: readonly string[]) => void
  emitCommandNotifications: (commands: readonly QueuedCommand[]) => void
  inputPrompt: string | AsyncIterable<string>
  maxTime: { limitMs: number; at: number } | undefined
  sessionTools: Tool[]
  baseToolNames: Set<string>
  answerSchemaOf: (turnSchema: Record<string, unknown> | undefined) => Record<string, unknown> | undefined
  assembleTools: (state: AppState, turnSchema?: Record<string, unknown>) => Tool[]
  registerElicitationHandlersForClient: (client: ConnectedMCPServer, serverName: string) => Promise<void>
  setReadFileCache: (cache: FileStateCache) => void
  statusIsProgress: (status: unknown) => boolean
  promisedWaitOf: (status: unknown) => Extract<RequestWaitV1, { kind: 'first-byte' }> | null | undefined
  statusRowOf: (status: unknown) => RowDraft | null
  tellFailedMcpServers: () => void
  tellSkippedProjectMcpServers: () => void
  recordNoticeRows: (notices: readonly QueuedCommand[], mark: { isVirtual: true } | { isMeta: true }) => Promise<void>
  recordHostNoticeRows: (notices: readonly QueuedCommand[]) => Promise<void>
  injectModelSwitchBreadcrumbs: (toModel: string, fromModel: string, words?: string, replacedDefault?: string) => Promise<void>
  advisorRoad: AdvisorRoad
  landAdvisorQuiet: (quiet: AdvisorQuiet) => void
  party: ReturnType<typeof import('../../crew/board/party.js').partyFeed>
  swarmLead: ReturnType<typeof import('../../crew/board/seam.js').watchSwarmLead>
  swarmResumes: ReturnType<typeof import('../../crew/board/seam.js').watchSwarmResumes>
  bootReady: Promise<void>
  isConcourseWorker: boolean
  isMainThreadCommand: (command: QueuedCommand) => boolean
  takeMainThread: () => QueuedCommand | undefined
  executeTurn: (command: QueuedCommand, batch: QueuedCommand[], onMessage: (message: RowDraft) => void, initialNotices?: QueuedCommand[]) => Promise<void>
  settleIdle: () => Promise<'reenter' | 'close' | 'stay'>
  idleTimeout: { start(): void; stop(): void }
  writeLine: (message: OutboundLine) => Promise<Row | null>
  disarmAgentFreshness: () => void
  stopDrainedNotificationFrames: () => void
  stopSdkDrain: () => void
  rateLimitListener: (limits: AnthropicLimits) => void
  carriersOf: (notices: readonly NoticeRecord[]) => QueuedCommand[]
  retireQueuedCommands: (commands: QueuedCommand[]) => void
  windowsShellRoadNotice: () => string | null
  commands: Command[]
  tools: Tool[]
  agents: AgentDefinition[]
  bootSettled: () => void
  releaseHookRows: (() => void) | undefined
  foldLanded: (row: OutboundLine) => void
  loaded: Awaited<ReturnType<typeof import('./resume.js').loadInitialMessages>>
  stopShellsForClose: () => Promise<void>
  stopHostNotices: () => void
  stopParty: () => void
  idleNudge: ReturnType<typeof import('./runnerDriver.js').startRunnerIdleNudge>
  buildBehindFloor: ReturnType<typeof setInterval> | null
  registerCleanup: typeof import('../../platform/processes/cleanupRegistry.js').registerCleanup
  modelInfos: ModelCatalogueEntry[]
  stdinLoop: Promise<void>
}

export const BOOT_ENDS = 'the boot ends'

export type BootMade<K extends keyof RunnerPorts> = Pick<RunnerPorts, K> | typeof BOOT_ENDS

export type BootStep<K extends keyof RunnerPorts> = {
  name: string
  makes: readonly K[]
  run: (ports: RunnerPorts) => BootMade<K> | Promise<BootMade<K>>
}

export type AnyBootStep = {
  name: string
  makes: readonly (keyof RunnerPorts)[]
  run: (ports: RunnerPorts) => Partial<RunnerPorts> | typeof BOOT_ENDS | Promise<Partial<RunnerPorts> | typeof BOOT_ENDS>
}

export type GivenPorts = Pick<RunnerPorts, 'live' | 'options' | 'inputPrompt' | 'getAppState' | 'setAppState' | 'commands' | 'tools' | 'agents' | 'isLocalShellTask' | 'killTask' | 'requestShellBackground' | 'windowsShellRoadNotice' | 'hydrateResumedRun'>

export function createRunnerPorts(given: GivenPorts, steps: readonly AnyBootStep[]): { ports: RunnerPorts; give: (step: AnyBootStep, made: Partial<RunnerPorts>) => void } {
  const held = new Map<PropertyKey, unknown>(Object.entries(given))
  const makerOf = new Map<PropertyKey, string>()
  for (const step of steps) for (const member of step.makes) makerOf.set(member, step.name)
  const ports = new Proxy({} as RunnerPorts, {
    get: (_none, member) => {
      if (held.has(member)) return held.get(member)
      if (typeof member === 'symbol' || member === 'then') return undefined
      const maker = makerOf.get(member)
      throw new Error(maker === undefined ? `the runner's port ${member} is made by no step of the boot` : `the runner's port ${member} is read before the boot step ${maker} has made it`)
    },
  })
  return {
    ports,
    give: (step, made) => {
      for (const member of step.makes) {
        if (!(member in made)) throw new Error(`the boot step ${step.name} names ${member} and did not make it`)
        held.set(member, made[member])
      }
    },
  }
}
