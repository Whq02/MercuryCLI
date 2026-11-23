import type { ContentBlock, ApiMessage, ApiStreamEvent, ToolUseBlock, ContentBlockParam } from './wire.js'
import type { APIError } from '../request-parts/sdkErrors.js'
import type { OverflowSignal } from '../requests/overflowSignal.js'
import type { MediaRefusal } from '../request-parts/mediaRefusal.js'
import type { StreamEndV1 } from '../../models/roads/streamIdleBudget.js'
import type { EffortAdjustedV1, EffortLevel } from '../../models/effort/effort.js'
import type { EffortStampV1 } from '../../sessions/fabric/record.js'
import type { AdvisorOrigin, SaturnOrigin, ScreenCommandOrigin } from './noticeRows.js'
import type { OutsideReportOrigin } from './outsideReport.js'
import type { UUID } from 'crypto'
import type {
  BranchAction,
  CommitKind,
  PrAction,
} from '../../tools/kit/gitOperationTracking.js'
import type { Progress } from '../../tools/kit/tool.js'
import type { Attachment } from '../attachments/attachments.js'
import type { FoldLedger } from '../compaction/foldLedger.js'
import type { FoldMemoryEnvelope } from '../compaction/foldRetirement.js'
import type { FoldCacheEpoch, FoldCacheUsage } from '../compaction/cacheEpoch.js'
import type { RequestGaugeAnchor } from '../run/requestGauge.js'
import type { TurnReceiptCounts } from '../../screen/cockpit/turnReceipt.js'
import type { NonNullableUsage } from '../request-parts/emptyUsage.js'
import type { LedgerMark } from '../rows/turn/ledgerMark.js'
import type { PermissionMode } from '../../permissions/rules/permissions.js'

export type SystemMessageLevel =
  | 'info'
  | 'warn'
  | 'warning'
  | 'error'
  | 'suggestion'

export const ASSISTANT_MESSAGE_ERRORS = [
  'authentication_failed',
  'billing_error',
  'rate_limit',
  'invalid_request',
  'server_error',
  'unknown',
  'max_output_tokens',
] as const
export type AssistantMessageError = (typeof ASSISTANT_MESSAGE_ERRORS)[number]

export type FailoverCause = 'overloaded' | 'unreachable' | 'sign-in' | 'unknown-model'

export type RefusedToolCall = {
  id: string
  name: string
  argumentsRaw: string
  argumentsLength?: number
  code: 'unknown-tool' | 'missing-id' | 'invalid-json' | 'not-an-object' | 'schema' | 'duplicate-id' | 'provider-malformed'
  reason: string
  offered?: string[]
}

export type PartialCompactDirection = 'from' | 'up_to'

export type MessageOrigin =
  | { kind: 'human' }
  | { kind: 'task-notification' }
  | { kind: 'build-behind' }
  | { kind: 'coordinator' }
  | { kind: 'channel'; server: string }
  | SaturnOrigin
  | AdvisorOrigin
  | ScreenCommandOrigin
  | OutsideReportOrigin

export type CompactMetadata = {
  trigger: 'manual' | 'auto' | 'overflow'
  preTokens: number
  postTokens?: number
  postEstimate?: { model: string; tokens: number }
  overflow?: OverflowSignal
  userContext?: string
  messagesSummarized?: number
  ledger?: FoldLedger
  memory?: FoldMemoryEnvelope
  cacheEpoch?: FoldCacheEpoch
  recentRounds?: { requested: number; kept: number; tokens: number; reason: string; folded?: number }
  requestGauge?: Pick<RequestGaugeAnchor, 'key' | 'epoch' | 'fixed' | 'density'>
  preservedSegment?: {
    headUuid: UUID
    anchorUuid: UUID
    tailUuid: UUID
  }
  preCompactDiscoveredTools?: string[]
  work?: {
    receipts: Array<{
      beforeUuid: string
      blockIndex?: number
      anchorUuid: string
      counts: TurnReceiptCounts
    }>
    recap: {
      turns: number
      toolCounts: Array<[string, number]>
      files: string[]
      toolFailures: number
      failedToolUseIds: string[]
    }
  }
}

export type AssistantMessage = {
  type: 'assistant'
  uuid: UUID
  timestamp: string
  message: ApiMessage
  requestId: string | undefined
  contextGauge?: RequestGaugeAnchor
  foldLanding?: {
    boundaryId: string
    usage: FoldCacheUsage
    fixedPrefix?: { previous: string | null; current: string; unchanged: boolean; bytes: number }
  }
  error?: AssistantMessageError
  errorDetails?: string
  failover?: FailoverCause
  providerWaitEndsAtMs?: number
  overflowSignal?: OverflowSignal
  mediaRefusal?: MediaRefusal
  apiError?: 'max_output_tokens'
  isApiErrorMessage?: boolean
  busyRecovery?: { provider: string; retries: number; elapsedMs: number; status?: number; code?: string; detail: string }
  busyRefusal?: BusyRefusalV1
  streamEnd?: StreamEndV1
  isMeta?: boolean
  isVirtual?: true
  retracted?: true
  research?: unknown
  refusedToolCalls?: RefusedToolCall[]
  reasoningOnly?: boolean
  effortAdjusted?: EffortAdjustedV1
  effort?: EffortStampV1
  thinkingPrefix?: string
  outputLimit?: number
  inReplyTo?: ReplyMark[]
  geminiProviderTurn?: {
    model: string
    parts: unknown[]
    calls: Array<{ id: string; name: string; nativeId?: string }>
    projection: string
    refused?: Array<{ id: string; reason: string }>
  }
  kimiProviderTurn?: { model: string; endpoint: string; projection: string; assistant: unknown }
  xaiProviderTurn?: { model: string; items: unknown[]; responseId?: string }
  zenProviderTurn?: { model: string; items: unknown[]; responseId?: string }
  compatProviderTurn?: { endpoint: string; model: string; items: unknown[]; responseId?: string }
  openrouterProviderTurn?: { model: string; items: unknown[]; responseId?: string }
  apexProviderTurn?: {
    provider: 'openai'
    responseId?: string
    items: unknown[]
    contractDigest?: string
    providerUsage?: {
      inputTokensTotal: number
      cachedInputTokens: number
      outputTokens: number
      cacheWriteInputTokens?: number
      reasoningOutputTokens?: number
      anomaly?: 'cached-exceeds-total'
    }
  }
}

export type ReplyMark = { uuid: string; at: string }

export type UserMessage = {
  type: 'user'
  message: {
    role: 'user'
    content: string | ContentBlockParam[]
  }
  isMeta?: true
  isVisibleInTranscriptOnly?: true
  isVirtual?: true
  queued?: true
  heldFor?: 'compaction'
  batchUuids?: string[]
  isCompactSummary?: true
  summarizeMetadata?: {
    messagesSummarized: number
    userContext?: string
    direction?: PartialCompactDirection
    contextReclaimedPct?: number
    tokensBefore?: number
    tokensAfter?: number
    keptMessages?: number
  }
  toolUseResult?: unknown
  mcpMeta?: {
    _meta?: Record<string, unknown>
    structuredContent?: Record<string, unknown>
  }
  uuid: UUID
  timestamp: string
  imagePasteIds?: number[]
  sourceToolAssistantUUID?: UUID
  sourceToolUseID?: string
  permissionMode?: PermissionMode
  replyEffort?: EffortLevel
  origin?: MessageOrigin
}

export type ProgressMessage<P extends Progress = Progress> = {
  type: 'progress'
  data: P
  toolUseID: string
  parentToolUseID: string
  uuid: UUID
  timestamp: string
}

export type AttachmentMessage<A extends Attachment = Attachment> = {
  type: 'attachment'
  attachment: A
  uuid: UUID
  timestamp: string
  queued?: true
  heldFor?: 'compaction'
}

export type HookResultMessage = AttachmentMessage | ProgressMessage | SystemInformationalMessage

export type SystemInformationalMessage = {
  type: 'system'
  subtype: 'informational'
  content: string
  isMeta?: boolean
  timestamp: string
  uuid: UUID
  toolUseID?: string
  level: SystemMessageLevel
  preventContinuation?: boolean
}

export type SystemSeatReceiptMessage = {
  type: 'system'
  subtype: 'seat_receipt'
  content: string
  level: SystemMessageLevel
  copyText?: string
  isMeta?: boolean
  timestamp: string
  uuid: UUID
}

export type SystemRosterTransitionMessage = {
  type: 'system'
  subtype: 'roster_transition'
  toggle: 'subagents' | 'workflows'
  on: boolean
  content: string
  level: SystemMessageLevel
  isMeta?: boolean
  timestamp: string
  uuid: UUID
}

export type SystemAdvisorQuietMessage = {
  type: 'system'
  subtype: 'advisor_quiet'
  content: string
  origin: AdvisorOrigin
  level: SystemMessageLevel
  isMeta?: boolean
  timestamp: string
  uuid: UUID
}

export type SystemStreamCutMessage = {
  type: 'system'
  subtype: 'stream_cut'
  content: string
  level: SystemMessageLevel
  count: number
  road?: string
  sent?: string
  code?: string
  isMeta?: boolean
  timestamp: string
  uuid: UUID
}

export type BusyRefusalV1 = {
  provider: string
  retries: number
  elapsedMs: number
  status?: number
  code?: string
}

export type SystemBusyRecoveryMessage = {
  type: 'system'
  subtype: 'busy_recovery'
  content: string
  provider: string
  retries: number
  elapsedMs: number
  status?: number
  code?: string
  level: SystemMessageLevel
  isMeta?: boolean
  timestamp: string
  uuid: UUID
}

export type SystemThinkingNoteMessage = {
  type: 'system'
  subtype: 'thinking_note'
  content: string
  level: SystemMessageLevel
  isMeta?: boolean
  timestamp: string
  uuid: UUID
}

export type DeadThinkingMark = {
  messageId: string
  blockIndex: number
}

export type SystemThinkingDeadMessage = {
  type: 'system'
  subtype: 'thinking_dead'
  dead: DeadThinkingMark[]
  content: string
  level: SystemMessageLevel
  isMeta?: boolean
  timestamp: string
  uuid: UUID
}

export type BoundPrefixToolMark = {
  name: string
  deferred: boolean
  definition?: string
}

export type BoundPrefixSection = {
  name: string
  key: string | null
  value: string | null
}

type SystemBridgeStatusMessage = {
  type: 'system'
  subtype: 'bridge_status'
  content: string
  url: string
  upgradeNudge?: string
  isMeta?: boolean
  timestamp: string
  uuid: UUID
}

export type SystemScheduledTaskFireMessage = {
  type: 'system'
  subtype: 'scheduled_task_fire'
  content: string
  isMeta?: boolean
  timestamp: string
  uuid: UUID
}

export type SystemTurnDurationMessage = {
  type: 'system'
  subtype: 'turn_duration'
  durationMs: number
  budgetTokens?: number
  budgetLimit?: number
  budgetNudges?: number
  messageCount?: number
  timestamp: string
  uuid: UUID
  isMeta?: boolean
}

export type SystemModelTransitionMessage = {
  type: 'system'
  subtype: 'model_transition'
  previous: string | null
  requested: string | null
  applied: string | null
  resolution: 'applied' | 'cancelled-pending'
  boundary: 'idle' | 'turn-boundary'
  crossProvider: boolean
  cacheDisposition: string
  isMeta?: boolean
  timestamp: string
  uuid: UUID
}

export type AwayRecapMetadata = {
  endedOnError?: boolean
  turns?: number
  filesTouched?: number
  toolFailures?: number
  topTools?: string
  lastActiveGapMs?: number
  branch?: string
  dirtyCount?: number
  dirtyDelta?: string
  certVerdict?: string
  certAgeMs?: number
  launchWon?: LaunchWonV1
}

export type LaunchWonV1 = {
  model?: { launch: string; session: string }
  effort?: { launch: string; session: string }
}

export type SystemAwaySummaryMessage = {
  type: 'system'
  subtype: 'away_summary'
  content: string
  recapMetadata?: AwayRecapMetadata
  isMeta?: boolean
  timestamp: string
  uuid: UUID
}

export type SystemMemorySavedMessage = {
  type: 'system'
  subtype: 'memory_saved'
  writtenPaths: string[]
  verb?: string
  isMeta?: boolean
  timestamp: string
  uuid: UUID
}

export type SystemAgentsKilledMessage = {
  type: 'system'
  subtype: 'agents_killed'
  isMeta?: boolean
  timestamp: string
  uuid: UUID
}

export type SystemApiMetricsMessage = {
  type: 'system'
  subtype: 'api_metrics'
  ttftMs: number
  otps: number
  isP50?: boolean
  hookDurationMs?: number
  turnDurationMs?: number
  toolDurationMs?: number
  toolCount?: number
  hookCount?: number
  configWriteCount?: number
  timestamp: string
  uuid: UUID
  isMeta?: boolean
}

export type SystemCloseUsageMessage = {
  type: 'system'
  subtype: 'close_usage'
  closeState: 'stored' | 'skipped' | 'none'
  noteChars?: number
  usage?: NonNullableUsage
  spent?: LedgerMark
  isMeta?: boolean
  timestamp: string
  uuid: UUID
}

export type SystemLocalCommandMessage = {
  type: 'system'
  subtype: 'local_command'
  content: string
  level: SystemMessageLevel
  isMeta?: boolean
  timestamp: string
  uuid: UUID
}

export type CrewChatKind = 'ask' | 'answer' | 'blocker' | 'result' | 'correction' | 'notice'
export type CrewChatRole = 'peer' | 'lead' | 'owner' | 'system'
export type CrewChatChannel = { kind: 'general' } | { kind: 'team' | 'whisper'; target: string }
export type CrewChatLifecycle = { kind: 'launched' | 'joined' | 'done' } | { kind: 'parked'; event: string }

export type SystemCrewChatMessage = {
  type: 'system'
  subtype: 'crew_chat'
  content: string
  level: SystemMessageLevel
  seq: number
  name: string
  slot?: number
  team?: string
  captain?: true
  authorRole: CrewChatRole
  kind: CrewChatKind
  mentions: string[]
  addresses: string[]
  channel?: CrewChatChannel
  lifecycle?: CrewChatLifecycle
  turnId?: string
  isMeta?: boolean
  timestamp: string
  uuid: UUID
}

export type SystemCompactBoundaryMessage = {
  type: 'system'
  subtype: 'compact_boundary'
  content: string
  isMeta?: boolean
  timestamp: string
  uuid: UUID
  level: SystemMessageLevel
  compactMetadata: CompactMetadata
  logicalParentUuid?: UUID
}

export type SystemMicrocompactBoundaryMessage = {
  type: 'system'
  subtype: 'microcompact_boundary'
  content: string
  isMeta?: boolean
  timestamp: string
  uuid: UUID
  level: SystemMessageLevel
  microcompactMetadata: {
    trigger: 'auto'
    preTokens: number
    tokensSaved: number
    compactedToolIds: string[]
    clearedAttachmentUUIDs: string[]
  }
}

export type SystemAPIErrorMessage = {
  type: 'system'
  subtype: 'api_error'
  level: SystemMessageLevel
  cause: Error | undefined
  error: APIError | Error
  errorDetail?: {
    name: string
    message: string
    status?: number
    code?: string
    transport?: {
      code?: string
      errno?: number
      syscall?: string
      via: 'cause-chain' | 'recent-failure'
      ageMs?: number
    }
  }
  retryInMs: number
  recoveryTimeoutMs?: number
  retryAttempt: number
  maxRetries: number
  timestamp: string
  uuid: UUID
}

type SystemFileSnapshotMessage = {
  type: 'system'
  subtype: 'file_snapshot'
  content: string
  level: SystemMessageLevel
  isMeta?: boolean
  timestamp: string
  uuid: UUID
  snapshotFiles: Array<{
    key: string
    path: string
    content: string
  }>
}

type SystemThinkingMessage = {
  type: 'system'
  subtype: 'thinking'
  content: string
  level: SystemMessageLevel
  isMeta?: boolean
  timestamp: string
  uuid: UUID
}

export type SystemMessage =
  | SystemInformationalMessage
  | SystemSeatReceiptMessage
  | SystemRosterTransitionMessage
  | SystemAdvisorQuietMessage
  | SystemStreamCutMessage
  | SystemBusyRecoveryMessage
  | SystemThinkingNoteMessage
  | SystemThinkingDeadMessage
  | SystemBridgeStatusMessage
  | SystemScheduledTaskFireMessage
  | SystemTurnDurationMessage
  | SystemModelTransitionMessage
  | SystemAwaySummaryMessage
  | SystemMemorySavedMessage
  | SystemAgentsKilledMessage
  | SystemApiMetricsMessage
  | SystemCloseUsageMessage
  | SystemLocalCommandMessage
  | SystemCrewChatMessage
  | SystemCompactBoundaryMessage
  | SystemMicrocompactBoundaryMessage
  | SystemAPIErrorMessage
  | SystemFileSnapshotMessage
  | SystemThinkingMessage

export type Message =
  | AssistantMessage
  | UserMessage
  | ProgressMessage
  | AttachmentMessage
  | SystemMessage

export type NormalizedAssistantMessage<
  C extends ContentBlock = ContentBlock,
> = Omit<AssistantMessage, 'message'> & {
  message: Omit<AssistantMessage['message'], 'content'> & {
    content: [C]
    context_management: ApiMessage['context_management']
  }
}

export type NormalizedUserMessage = Omit<UserMessage, 'message'> & {
  message: {
    role: 'user'
    content: ContentBlockParam[]
  }
  sourceUuid?: string
}

export type NormalizedMessage =
  | NormalizedAssistantMessage
  | NormalizedUserMessage
  | ProgressMessage
  | AttachmentMessage
  | SystemMessage

export type GroupedToolUseMessage = {
  type: 'grouped_tool_use'
  toolName: string
  messages: NormalizedAssistantMessage<ToolUseBlock>[]
  results: NormalizedUserMessage[]
  displayMessage: NormalizedAssistantMessage<ToolUseBlock>
  uuid: string
  timestamp: string
  messageId: string
}

export type CollapsedReadSearchGroup = {
  type: 'collapsed_read_search'
  searchCount: number
  readCount: number
  listCount: number
  memorySearchCount: number
  memoryReadCount: number
  memoryWriteCount: number
  readFilePaths: string[]
  searchArgs: string[]
  latestDisplayHint: string | undefined
  messages: CollapsibleMessage[]
  displayMessage: CollapsibleMessage
  uuid: UUID
  timestamp: string
  mcpCallCount?: number
  mcpServerNames?: string[]
  bashCount?: number
  gitOpBashCount?: number
  commits?: { sha: string; kind: CommitKind }[]
  pushes?: { branch: string }[]
  branches?: { ref: string; action: BranchAction }[]
  prs?: { number: number; url?: string; action: PrAction }[]
  relevantMemories?: { path: string; content: string; mtimeMs: number }[]
}

export type CollapsibleMessage =
  | NormalizedAssistantMessage
  | NormalizedUserMessage
  | GroupedToolUseMessage

export type TurnReceiptMessage = {
  type: 'turn_receipt'
  uuid: string
  contextDelta?: number
  counts: {
    scratchpadEdits: number
    fileEdits: number
    adds: number
    dels: number
    reads: number
    searches: number
    fetches: number
    commands: number
    browser: number
    agents: number
    delegatedTokens: number
    delegatedCostUSD: number
    delegatedUnpriced: number
    tools: Record<string, number>
  }
}

export type RenderableMessage =
  | NormalizedAssistantMessage
  | NormalizedUserMessage
  | AttachmentMessage
  | SystemMessage
  | GroupedToolUseMessage
  | CollapsedReadSearchGroup
  | TurnReceiptMessage

export type StreamEvent = {
  type: 'stream_event'
  event: ApiStreamEvent
  ttftMs?: number
}

export type RequestStartEvent = {
  type: 'stream_request_start'
}

export type TombstoneMessage = {
  type: 'tombstone'
  message: AssistantMessage
}

export interface ModelTransitionReceipt {
  previous: string | null
  requested: string | null
  applied: string | null
  resolution: 'applied' | 'cancelled-pending'
  boundary: 'idle' | 'turn-boundary'
  crossProvider: boolean
  cacheDisposition: 'keyed-sections-recompute-once' | 'none'
}
