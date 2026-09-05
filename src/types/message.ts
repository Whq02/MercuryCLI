
import type { ContentBlock, ApiMessage, ApiStreamEvent, ToolUseBlock, ApiUsage, ContentBlockParam, ToolResultBlockParam } from './wire.js'
import type { APIError } from '../services/api/sdkErrors.js'
import type { OverflowSignal } from '../services/api/overflowSignal.js'
import type { StreamEndV1 } from '../services/providers/streamIdleBudget.js'
import type { EffortAdjustedV1 } from '../utils/effort.js'
import type { UUID } from 'crypto'
import type {
  BranchAction,
  CommitKind,
  PrAction,
} from '../tools/shared/gitOperationTracking.js'
import type { Progress } from '../Tool.js'
import type { Attachment } from '../utils/attachments.js'


export type SystemMessageLevel =
  | 'info'
  | 'warn'
  | 'warning'
  | 'error'
  | 'suggestion'

export type AssistantMessageError =
  | 'authentication_failed'
  | 'billing_error'
  | 'rate_limit'
  | 'invalid_request'
  | 'server_error'
  | 'unknown'
  | 'max_output_tokens'

export type RefusedToolCall = {
  id: string
  name: string
  argumentsRaw: string
  code: 'unknown-tool' | 'missing-id' | 'invalid-json' | 'not-an-object' | 'schema' | 'duplicate-id'
  reason: string
}

export type PartialCompactDirection = 'from' | 'up_to'

export type MessageOrigin =
  | { kind: 'human' }
  | { kind: 'task-notification' }
  | { kind: 'coordinator' }
  | { kind: 'channel'; server: string }

export type CompactMetadata = {
  trigger: 'manual' | 'auto' | 'overflow'
  preTokens: number
  overflow?: OverflowSignal
  userContext?: string
  messagesSummarized?: number
  preservedSegment?: {
    headUuid: UUID
    anchorUuid: UUID
    tailUuid: UUID
  }
  preCompactDiscoveredTools?: string[]
}

export type StopHookInfo = {
  command?: string
  promptText?: string
  durationMs?: number
}


export type AssistantAPIMessage = Omit<
  ApiMessage,
  'diagnostics' | 'stop_details'
> &
  Partial<Pick<ApiMessage, 'diagnostics' | 'stop_details'>>

export type AssistantMessage = {
  type: 'assistant'
  uuid: UUID
  timestamp: string
  message: AssistantAPIMessage
  requestId: string | undefined
  error?: AssistantMessageError
  errorDetails?: string
  overflowSignal?: OverflowSignal
  apiError?: 'max_output_tokens'
  isApiErrorMessage?: boolean
  isMeta?: boolean
  isVirtual?: true
  advisorModel?: string
  research?: unknown
  refusedToolCalls?: RefusedToolCall[]
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
  streamEnd?: StreamEndV1
  effortAdjusted?: EffortAdjustedV1
}


export type UserMessage = {
  type: 'user'
  uuid: UUID
  timestamp: string
  message: {
    role: 'user'
    content: string | ContentBlockParam[]
  }
  isMeta?: true
  isVisibleInTranscriptOnly?: true
  isVirtual?: true
  queued?: true
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
  imagePasteIds?: number[]
  sourceToolAssistantUUID?: UUID
  sourceToolUseID?: string
  planContent?: string
  permissionMode?: import('./permissions.js').PermissionMode
  origin?: MessageOrigin
}


export type ProgressMessage<P extends Progress = Progress> = {
  type: 'progress'
  uuid: UUID
  timestamp: string
  data: P
  toolUseID: string
  parentToolUseID: string
}


export type AttachmentMessage<A extends Attachment = Attachment> = {
  type: 'attachment'
  uuid: UUID
  timestamp: string
  attachment: A
}

export type HookResultMessage = AttachmentMessage | ProgressMessage


export type SystemInformationalMessage = {
  type: 'system'
  subtype: 'informational'
  content: string
  level: SystemMessageLevel
  isMeta?: boolean
  uuid: UUID
  timestamp: string
  toolUseID?: string
  preventContinuation?: boolean
}

export type SystemSeatReceiptMessage = {
  type: 'system'
  subtype: 'seat_receipt'
  content: string
  level: SystemMessageLevel
  isMeta?: boolean
  uuid: UUID
  timestamp: string
}

export type SystemRosterTransitionMessage = {
  type: 'system'
  subtype: 'roster_transition'
  toggle: 'subagents' | 'workflows'
  on: boolean
  content: string
  level: SystemMessageLevel
  isMeta?: boolean
  uuid: UUID
  timestamp: string
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
  uuid: UUID
  timestamp: string
}

export type SystemPermissionRetryMessage = {
  type: 'system'
  subtype: 'permission_retry'
  content: string
  commands: string[]
  level: SystemMessageLevel
  isMeta?: boolean
  uuid: UUID
  timestamp: string
}

export type SystemBridgeStatusMessage = {
  type: 'system'
  subtype: 'bridge_status'
  content: string
  url: string
  upgradeNudge?: string
  isMeta?: boolean
  uuid: UUID
  timestamp: string
}

export type SystemScheduledTaskFireMessage = {
  type: 'system'
  subtype: 'scheduled_task_fire'
  content: string
  isMeta?: boolean
  uuid: UUID
  timestamp: string
}

export type SystemStopHookSummaryMessage = {
  type: 'system'
  subtype: 'stop_hook_summary'
  hookCount: number
  hookInfos: StopHookInfo[]
  hookErrors: string[]
  preventedContinuation: boolean
  stopReason: string | undefined
  hasOutput: boolean
  level: SystemMessageLevel
  uuid: UUID
  timestamp: string
  toolUseID?: string
  hookLabel?: string
  totalDurationMs?: number
}

export type SystemTurnDurationMessage = {
  type: 'system'
  subtype: 'turn_duration'
  durationMs: number
  budgetTokens?: number
  budgetLimit?: number
  budgetNudges?: number
  messageCount?: number
  uuid: UUID
  timestamp: string
  isMeta?: boolean
}

export type SystemModelTransitionMessage = {
  type: 'system'
  subtype: 'model_transition'
  previous: string | null
  requested: string | null
  applied: string | null
  resolution: 'applied' | 'cancelled-pending'
  boundary: 'idle' | 'turn-boundary' | 'autopilot-tool'
  crossProvider: boolean
  cacheDisposition: string
  uuid: UUID
  timestamp: string
  isMeta?: boolean
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
}

export type SystemAwaySummaryMessage = {
  type: 'system'
  subtype: 'away_summary'
  content: string
  recapMetadata?: AwayRecapMetadata
  uuid: UUID
  timestamp: string
  isMeta?: boolean
}

export type SystemMemorySavedMessage = {
  type: 'system'
  subtype: 'memory_saved'
  writtenPaths: string[]
  uuid: UUID
  timestamp: string
  isMeta?: boolean
  teamCount?: number
  verb?: string
}

export type SystemAgentsKilledMessage = {
  type: 'system'
  subtype: 'agents_killed'
  uuid: UUID
  timestamp: string
  isMeta?: boolean
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
  classifierDurationMs?: number
  toolCount?: number
  hookCount?: number
  classifierCount?: number
  configWriteCount?: number
  uuid: UUID
  timestamp: string
  isMeta?: boolean
}

export type SystemLocalCommandMessage = {
  type: 'system'
  subtype: 'local_command'
  content: string
  level: SystemMessageLevel
  uuid: UUID
  timestamp: string
  isMeta?: boolean
}

export type SystemCompactBoundaryMessage = {
  type: 'system'
  subtype: 'compact_boundary'
  content: string
  isMeta?: boolean
  uuid: UUID
  timestamp: string
  level: SystemMessageLevel
  compactMetadata: CompactMetadata
  logicalParentUuid?: UUID
}

export type SystemMicrocompactBoundaryMessage = {
  type: 'system'
  subtype: 'microcompact_boundary'
  content: string
  isMeta?: boolean
  uuid: UUID
  timestamp: string
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
  uuid: UUID
  timestamp: string
}

export type SystemFileSnapshotMessage = {
  type: 'system'
  subtype: 'file_snapshot'
  content: string
  level: SystemMessageLevel
  isMeta?: boolean
  uuid: UUID
  timestamp: string
  snapshotFiles: Array<{
    key: string
    path: string
    content: string
  }>
}

export type SystemThinkingMessage = {
  type: 'system'
  subtype: 'thinking'
  content: string
  level: SystemMessageLevel
  isMeta?: boolean
  uuid: UUID
  timestamp: string
}

export type SystemMessage =
  | SystemInformationalMessage
  | SystemSeatReceiptMessage
  | SystemRosterTransitionMessage
  | SystemThinkingDeadMessage
  | SystemPermissionRetryMessage
  | SystemBridgeStatusMessage
  | SystemScheduledTaskFireMessage
  | SystemStopHookSummaryMessage
  | SystemTurnDurationMessage
  | SystemModelTransitionMessage
  | SystemAwaySummaryMessage
  | SystemMemorySavedMessage
  | SystemAgentsKilledMessage
  | SystemApiMetricsMessage
  | SystemLocalCommandMessage
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
  message: Omit<AssistantAPIMessage, 'content'> & {
    content: [C]
    context_management: ApiMessage['context_management']
  }
}

export type NormalizedUserMessage = Omit<UserMessage, 'message'> & {
  message: {
    role: 'user'
    content: ContentBlockParam[]
  }
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
  replCount: number
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
  teamMemorySearchCount?: number
  teamMemoryReadCount?: number
  teamMemoryWriteCount?: number
  mcpCallCount?: number
  mcpServerNames?: string[]
  bashCount?: number
  gitOpBashCount?: number
  commits?: { sha: string; kind: CommitKind }[]
  pushes?: { branch: string }[]
  branches?: { ref: string; action: BranchAction }[]
  prs?: { number: number; url?: string; action: PrAction }[]
  hookTotalMs?: number
  hookCount?: number
  hookInfos?: StopHookInfo[]
  relevantMemories?: { path: string; content: string; mtimeMs: number }[]
}

export type CollapsibleMessage =
  | NormalizedAssistantMessage
  | NormalizedUserMessage
  | GroupedToolUseMessage

export type TurnReceiptMessage = {
  type: 'turn_receipt'
  uuid: string
  counts: {
    scratchpadEdits: number
    fileEdits: number
    adds: number
    dels: number
    reads: number
    searches: number
    commands: number
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

export type ToolUseSummaryMessage = {
  type: 'tool_use_summary'
  summary: string
  precedingToolUseIds: string[]
  uuid: UUID
  timestamp: string
}
