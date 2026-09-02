/**
 * Mercury application message taxonomy.
 *
 * This is the in-app message model that wraps the Mercury wire vocabulary
 * (ApiMessage / ContentBlock / ApiUsage / ContentBlockParam — types/wire.ts)
 * with the structural metadata the REPL, transcript, query loop, and renderers
 * need (uuid / timestamp / origin / meta flags / error envelopes).
 *
 * Discriminants (the literal each consumer switches on):
 *   - top-level `type`: 'assistant' | 'user' | 'progress' | 'attachment' | 'system'
 *     (+ the render/stream-only 'grouped_tool_use' | 'collapsed_read_search' |
 *     'tombstone' | 'tool_use_summary' | 'stream_event' | 'stream_request_start')
 *   - SystemMessage `subtype`: the System*Message family key.
 *
 * no provider-SDK type imports here — the wire vocabulary is
 * Mercury-owned (types/wire.ts), and the provider SDK meets it only inside
 * the codec leaves (services/api/**). See src/utils/messages.ts for the
 * factory functions that construct every variant below.
 */

import type { ContentBlock, ApiMessage, ApiStreamEvent, ToolUseBlock, ApiUsage, ContentBlockParam, ToolResultBlockParam } from './wire.js'
import type { APIError } from '../services/api/sdkErrors.js'
import type { OverflowSignal } from '../services/api/overflowSignal.js'
import type { UUID } from 'crypto'
import type {
  BranchAction,
  CommitKind,
  PrAction,
} from '../tools/shared/gitOperationTracking.js'
import type { Progress } from '../Tool.js'
import type { Attachment } from '../utils/attachments.js'

// ============================================================================
// Shared scalars / metadata
// ============================================================================

/**
 * Severity attached to System*Message rows (drives renderer color/glyph).
 * (createSystemMessage callers pass 'info' | 'warning' | 'suggestion'; the
 *  factories also emit 'warn'/'error'.)
 */
export type SystemMessageLevel =
  | 'info'
  | 'warn'
  | 'warning'
  | 'error'
  | 'suggestion'

/**
 * Structured API-level error code carried on an assistant message. Mirrors the
 * agent-SDK `SDKAssistantMessageError` enum (SDKAssistantMessageErrorSchema in
 * src/entrypoints/sdk/coreSchemas.ts) — inlined because that symbol is exported
 * only as a runtime zod schema, not as a type.
 */
export type AssistantMessageError =
  | 'authentication_failed'
  | 'billing_error'
  | 'rate_limit'
  | 'invalid_request'
  | 'server_error'
  | 'unknown'
  | 'max_output_tokens'

/**
 * A tool call a provider transport REFUSED at the wire boundary (the
 * schema-enforcement law in services/providers/toolCallGate.ts). The call
 * never minted a tool_use block — no consumer between the wire and the
 * executor ever holds its arguments — and the turn machine turns this
 * record into the model-visible correction on the next user turn.
 */
export type RefusedToolCall = {
  /** The provider's call id, exactly as delivered (never paired). */
  id: string
  /** The tool name exactly as the model spelled it ('' when absent). */
  name: string
  /** The raw argument bytes as the provider delivered them. */
  argumentsRaw: string
  code: 'unknown-tool' | 'missing-id' | 'invalid-json' | 'not-an-object' | 'schema' | 'duplicate-id'
  /** Model-readable reason; schema issues use the executor's own formatter. */
  reason: string
}

/**
 * Direction for a partial (message-selector) compaction. `'from'` summarizes
 * everything from the selected message onward; `'up_to'` summarizes the prefix
 * up to (and including) the selected message.
 * (see src/services/compact/compact.ts + REPL onSummarize)
 */
export type PartialCompactDirection = 'from' | 'up_to'

/**
 * Provenance of a user message / queued command. `undefined` = human keyboard
 * input. Stamped structurally so the transcript records origin without parsing
 * XML tags out of the content.
 * (see utils/messages.ts queued_command handling, utils/attachments.ts,
 *  services/mcp/localChannelBus.ts)
 */
export type MessageOrigin =
  | { kind: 'human' }
  | { kind: 'task-notification' }
  | { kind: 'coordinator' }
  | { kind: 'channel'; server: string }

/**
 * Metadata recorded on a compact boundary marker. Round-trips through the SDK
 * compact_metadata shape via utils/messages/mappers.ts.
 */
export type CompactMetadata = {
  /** 'overflow' — the fold ran as the recovery ladder's rung after a
   *  request overflowed the window (auto-compaction's emergency arm). */
  trigger: 'manual' | 'auto' | 'overflow'
  preTokens: number
  /** The overflow this fold answered (trigger 'overflow' only). */
  overflow?: OverflowSignal
  userContext?: string
  messagesSummarized?: number
  preservedSegment?: {
    headUuid: UUID
    anchorUuid: UUID
    tailUuid: UUID
  }
  /** Tool names discovered (via ToolSearch) before this compaction; carried
   *  forward so the post-compact turn keeps them loaded. Assigned in place. */
  preCompactDiscoveredTools?: string[]
}

/**
 * One Stop/PreToolUse/PostToolUse hook invocation recorded into a stop-hook
 * summary (or absorbed into a collapsed read/search group).
 * (see query/stopHooks.ts + services/tools/toolExecution.ts producers)
 */
export type StopHookInfo = {
  command?: string
  promptText?: string
  durationMs?: number
}

// ============================================================================
// Assistant
// ============================================================================

/**
 * The raw API message carried on an AssistantMessage. The beta `ApiMessage`
 * shape, but `diagnostics` and `stop_details` are optional: the synthetic
 * producers (baseCreateAssistantMessage) build the literal without them, and no
 * consumer reads them.
 */
export type AssistantAPIMessage = Omit<
  ApiMessage,
  'diagnostics' | 'stop_details'
> &
  Partial<Pick<ApiMessage, 'diagnostics' | 'stop_details'>>

/**
 * A model turn. `message` is the raw API (beta) message; the extra fields carry
 * transcript/error metadata. Produced by createAssistantMessage /
 * baseCreateAssistantMessage and the live API path in services/providers/anthropic/index.ts.
 */
export type AssistantMessage = {
  type: 'assistant'
  uuid: UUID
  timestamp: string
  message: AssistantAPIMessage
  /** Request id from the API response stream/headers (undefined for synthetic). */
  requestId: string | undefined
  /** Structured API-level error (carried for SDK consumers / fallback logic). */
  error?: AssistantMessageError
  /** Human-readable error detail string. */
  errorDetails?: string
  /** THE context-overflow signal (services/api/overflowSignal.ts): stamped
   *  by the provider runtime that minted this API-error message when the
   *  wire refused the request for not fitting the window — the one field
   *  the recovery ladder, the fold's retry and the coordinator read. */
  overflowSignal?: OverflowSignal
  /** Set on the synthetic message wrapping an APIError surfaced to the user. */
  apiError?: 'max_output_tokens'
  /** True when this message is a rendered API-error notice, not a real turn. */
  isApiErrorMessage?: boolean
  /** Hidden from the transcript / not a real model turn. */
  isMeta?: boolean
  /** Synthetic message injected locally (never round-tripped to the API). */
  isVirtual?: true
  /** Advisor model id when this turn came from the advisor path. */
  advisorModel?: string
  /** Internal research payload (USER_TYPE === 'ant' only). Mutated in place. */
  research?: unknown
  /**
   * Tool calls the provider transport refused before they could mint a
   * tool_use block (services/providers/toolCallGate.ts). Carried on the
   * settled note message so the turn machine can hand the model the typed
   * correction; inert in the transcript.
   */
  refusedToolCalls?: RefusedToolCall[]
  /**
   * the provider-turn wire record for stateless
   * replay — the settled turn's ordered output items (reasoning items with
   * encrypted content · function calls · message text, provider shapes) plus
   * the provider response id (receipts only, never chaining). Written by the
   * native OpenAI runtime at settlement via direct mutation (the transcript
   * write queue holds the reference); replayed by the request bridge; items
   * stay `unknown` here — the bridge decodes defensively (transcripts come
   * from disk).
   */
  apexProviderTurn?: {
    provider: 'openai'
    responseId?: string
    items: unknown[]
    /** The behaviour-contract digest active when this turn ran (A3 —
     *  receipts material; never affects replay). */
    contractDigest?: string
    /** the provider's NATIVE usage semantics, receipt-only
     *  — OpenAI reports INCLUSIVE input (cached ⊆ input_tokens) while the
     *  canonical envelope is DISJOINT (uncached input beside cache_read).
     *  The raw inclusive totals survive here and ONLY here; every consumer
     *  takes the canonical envelope. `anomaly` marks cached>total (clamped
     *  to zero uncached in the canonical fields, never negative). */
    providerUsage?: {
      inputTokensTotal: number
      cachedInputTokens: number
      outputTokens: number
      reasoningOutputTokens?: number
      anomaly?: 'cached-exceeds-total'
    }
  }
}

// ============================================================================
// User
// ============================================================================

/**
 * A user / tool-result turn. `message.content` is a string for plain prompts or
 * a ContentBlockParam[] for tool results / images / multi-block input.
 * Produced by createUserMessage.
 */
export type UserMessage = {
  type: 'user'
  uuid: UUID
  timestamp: string
  message: {
    role: 'user'
    content: string | ContentBlockParam[]
  }
  /** Hidden from the transcript (caveats, synthetic tool inputs, etc.). */
  isMeta?: true
  /** Visible in the scrollback transcript but never sent to the model. */
  isVisibleInTranscriptOnly?: true
  /** Synthetic message injected locally (never round-tripped to the API). */
  isVirtual?: true
  /** This user message is a compact summary (post-compaction seed). */
  isCompactSummary?: true
  /** Metadata for a partial/compact summary user message. */
  summarizeMetadata?: {
    messagesSummarized: number
    userContext?: string
    direction?: PartialCompactDirection
    /** The /compact receipt's honest numbers (attached at enrich time from
     *  the compaction result's own counts — never fabricated; the card
     *  renders only what is present). */
    contextReclaimedPct?: number
    tokensBefore?: number
    tokensAfter?: number
    /** Messages the verbatim keep-tail carried across the fold. */
    keptMessages?: number
  }
  /** Structured tool output (matches the producing tool's `Output` type). */
  toolUseResult?: unknown
  /** MCP protocol metadata passed through to SDK consumers (never to model). */
  mcpMeta?: {
    _meta?: Record<string, unknown>
    structuredContent?: Record<string, unknown>
  }
  /** Paste ids for image content blocks (parallel to image blocks in content). */
  imagePasteIds?: number[]
  /** For tool_result messages: uuid of the assistant message that issued it. */
  sourceToolAssistantUUID?: UUID
  /**
   * Tool-use id tagging this user message transient until that tool resolves
   * (tagMessagesWithToolUseID). Read by getToolUseID on the normalized form.
   */
  sourceToolUseID?: string
  /** Plan text stashed on a user message during clear-context plan carry-over. */
  planContent?: string
  /** Permission mode active when this message was sent (rewind restoration). */
  permissionMode?: import('./permissions.js').PermissionMode
  /** Provenance — undefined = human keyboard input. */
  origin?: MessageOrigin
}

// ============================================================================
// Progress
// ============================================================================

/**
 * A progress event emitted by a running tool or hook. Generic over its `data`
 * payload (`Progress` = ToolProgressData | HookProgress). Produced by
 * createProgressMessage.
 */
export type ProgressMessage<P extends Progress = Progress> = {
  type: 'progress'
  uuid: UUID
  timestamp: string
  data: P
  /** The tool_use id this progress belongs to. */
  toolUseID: string
  /** The parent tool_use id (the tool whose execution spawned this). */
  parentToolUseID: string
}

// ============================================================================
// Attachment
// ============================================================================

/**
 * A synthetic system-reminder / hook / file-reference attachment threaded into
 * the conversation. Generic over the underlying `Attachment` variant (e.g.
 * `AttachmentMessage<HookAttachment>`). Produced by createAttachmentMessage.
 */
export type AttachmentMessage<A extends Attachment = Attachment> = {
  type: 'attachment'
  uuid: UUID
  timestamp: string
  attachment: A
}

/**
 * A hook-produced message threaded into the conversation: an attachment
 * (session-start / additional-context / hook status) or a progress event
 * (streamed hook progress). stopHooks narrows on `.type` to 'attachment' /
 * 'progress'. (see utils/sessionStart.ts, utils/hooks.ts, query/stopHooks.ts)
 */
export type HookResultMessage = AttachmentMessage | ProgressMessage

// ============================================================================
// System message family (discriminated on `subtype`)
// ============================================================================

/** Informational system line (the generic createSystemMessage product). */
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

/** one VISIBLE row per applied (or honestly timed-out)
 *  operator seat reslot. Its own subtype on purpose: info-level informational
 *  rows are quiet-by-design in the default transcript, and a receipt must
 *  never be quiet. UI-only, never enters the API conversation. */
export type SystemSeatReceiptMessage = {
  type: 'system'
  subtype: 'seat_receipt'
  content: string
  level: SystemMessageLevel
  isMeta?: boolean
  uuid: UUID
  timestamp: string
}

/** "Allowed <commands>" confirmation after a permission retry. */
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

/** /remote-control bridge status line. */
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

/** A scheduled task firing notice. */
export type SystemScheduledTaskFireMessage = {
  type: 'system'
  subtype: 'scheduled_task_fire'
  content: string
  isMeta?: boolean
  uuid: UUID
  timestamp: string
}

/** Summary of the Stop / SubagentStop hooks that ran at end of turn. */
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

/** Per-turn duration + token-budget summary line. */
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

/** A settled model transition: the durable projection
 *  of the settlement owner's receipt — one row per resolved transition,
 *  appended exactly once by the REPL consumer effect. Field spellings match
 *  ModelTransitionReceipt (utils/model/modelTransition.ts). */
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

/** Fork resume-recap card data (trust-cockpit re-entry). Every field optional —
 *  a message without it (older sessions, the upstream blur-summary path) renders
 *  the plain dim line exactly as before. Ages/gaps are raw ms (formatted at
 *  render); dirtyDelta is the preformatted '+a/-r' tail. */
export type AwayRecapMetadata = {
  endedOnError?: boolean
  turns?: number
  filesTouched?: number
  /** Tool calls whose result carried is_error — the run is not "clean" over them. */
  toolFailures?: number
  /** Top tracked tools, space-joined ('Edit×2 Bash×1'). */
  topTools?: string
  lastActiveGapMs?: number
  branch?: string
  dirtyCount?: number
  dirtyDelta?: string
  /** /health cert verdict ('certified'|'caution'|'fault') or 'none' (never issued). */
  certVerdict?: string
  certAgeMs?: number
}

/** Summary of an away/background session shown on return. */
export type SystemAwaySummaryMessage = {
  type: 'system'
  subtype: 'away_summary'
  content: string
  /** Present ⇒ Mercury renders the ResumeRecapCard; absent ⇒ the plain ※ line. */
  recapMetadata?: AwayRecapMetadata
  uuid: UUID
  timestamp: string
  isMeta?: boolean
}

/** "Saved to memory" notice listing the written memory file paths. */
export type SystemMemorySavedMessage = {
  type: 'system'
  subtype: 'memory_saved'
  writtenPaths: string[]
  uuid: UUID
  timestamp: string
  isMeta?: boolean
  /** Count of team-memory entries saved (feature('TEAMMEM')). Assigned in place. */
  teamCount?: number
  /** Override verb shown in the row (e.g. 'Improved' for autoDream). */
  verb?: string
}

/** "All background agents stopped" notice. */
export type SystemAgentsKilledMessage = {
  type: 'system'
  subtype: 'agents_killed'
  uuid: UUID
  timestamp: string
  isMeta?: boolean
}

/** API timing metrics (ttft, otps, durations) surfaced for `--verbose`/metrics. */
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

/** The breadcrumb shown when a local (slash/bash) command runs. */
export type SystemLocalCommandMessage = {
  type: 'system'
  subtype: 'local_command'
  content: string
  level: SystemMessageLevel
  uuid: UUID
  timestamp: string
  isMeta?: boolean
}

/** Marks where the conversation was compacted (full compaction boundary). */
export type SystemCompactBoundaryMessage = {
  type: 'system'
  subtype: 'compact_boundary'
  content: string
  isMeta?: boolean
  uuid: UUID
  timestamp: string
  level: SystemMessageLevel
  compactMetadata: CompactMetadata
  /** Relink anchor for the pre-compact tail (set when preserving a segment). */
  logicalParentUuid?: UUID
}

/** Marks a time-based microcompaction (tool-result clearing) boundary. */
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

/** A transient API error notice (retry countdown) rendered in the transcript. */
export type SystemAPIErrorMessage = {
  type: 'system'
  subtype: 'api_error'
  level: SystemMessageLevel
  cause: Error | undefined
  /** The live error instance (in-process consumers). Serializes as `{}` in
   *  JSONL — the transcript truth rides errorDetail. Widened beyond APIError
   *  so non-API transient errors surface instead of sleeping silently
   * */
  error: APIError | Error
  /** The STRUCTURED error snapshot — always populated, survives JSONL
   *  round-trips (the `"error": {}` field-diagnostic class). `transport`
   *  carries the deepest cause-chain code/errno/syscall (N-02 — undici
   *  buries UND_ERR_* two levels down), or, for the SDK's cause-dropping
   *  timeout class, the process-recent transport failure labeled honestly
   *  as 'recent-failure' with its age. */
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
  /** The REAL delay before the next attempt (the producer sleeps exactly
   *  this); 0 = proceeding now (e.g. the non-streaming fallback). */
  retryInMs: number
  /** A blocking recovery call is starting; this is its CEILING in ms — a
   *  budget, never a scheduled wait (H-01: the fallback notice used to
   *  overload retryInMs with this, rendering a fake 300s countdown). */
  recoveryTimeoutMs?: number
  retryAttempt: number
  maxRetries: number
  uuid: UUID
  timestamp: string
}

/** A persisted snapshot of session files (plan/todos) for remote sessions. */
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

/** Reasoning-summary system line (rendered as null; produced for transcript). */
export type SystemThinkingMessage = {
  type: 'system'
  subtype: 'thinking'
  content: string
  level: SystemMessageLevel
  isMeta?: boolean
  uuid: UUID
  timestamp: string
}

/** The full discriminated union of in-transcript system messages. */
export type SystemMessage =
  | SystemInformationalMessage
  | SystemSeatReceiptMessage
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

// ============================================================================
// Top-level Message union
// ============================================================================

/**
 * The canonical conversation message. The query loop, transcript store, and API
 * mappers all operate on `Message[]`.
 */
export type Message =
  | AssistantMessage
  | UserMessage
  | ProgressMessage
  | AttachmentMessage
  | SystemMessage

// ============================================================================
// Normalized messages (one content block per message)
// ============================================================================

/**
 * An assistant message split so its `message.content` holds exactly one block.
 * Generic over the single block type (defaults to any ContentBlock; narrowed
 * to e.g. ToolUseBlock where the code knows the block kind).
 * Produced by normalizeMessages.
 */
export type NormalizedAssistantMessage<
  C extends ContentBlock = ContentBlock,
> = Omit<AssistantMessage, 'message'> & {
  message: Omit<AssistantAPIMessage, 'content'> & {
    content: [C]
    /** Always materialized to null when absent on normalization. */
    context_management: ApiMessage['context_management']
  }
}

/**
 * A user message split so its `message.content` holds exactly one block (always
 * an array after normalization, even for plain-string input).
 * Produced by normalizeMessages.
 */
export type NormalizedUserMessage = Omit<UserMessage, 'message'> & {
  message: {
    role: 'user'
    content: ContentBlockParam[]
  }
}

/** A normalized message of any kind (the per-block render/lookup unit). */
export type NormalizedMessage =
  | NormalizedAssistantMessage
  | NormalizedUserMessage
  | ProgressMessage
  | AttachmentMessage
  | SystemMessage

// ============================================================================
// Render-only grouping messages
// ============================================================================

/**
 * Consecutive same-tool tool_uses (from one assistant message) coalesced into a
 * single rendered row. Produced by utils/groupToolUses.ts.
 */
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

/**
 * A run of consecutive read/search/list operations collapsed into one summary
 * row ("Read N files · Searched M times"). Produced by
 * utils/collapseReadSearch.ts; many fields are conditionally attached.
 */
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
  // Team-memory counts (feature('TEAMMEM') only)
  teamMemorySearchCount?: number
  teamMemoryReadCount?: number
  teamMemoryWriteCount?: number
  // MCP calls
  mcpCallCount?: number
  mcpServerNames?: string[]
  // Fullscreen-mode bash / git operation rollups
  bashCount?: number
  gitOpBashCount?: number
  commits?: { sha: string; kind: CommitKind }[]
  pushes?: { branch: string }[]
  branches?: { ref: string; action: BranchAction }[]
  prs?: { number: number; url?: string; action: PrAction }[]
  // Absorbed PreToolUse hook timings
  hookTotalMs?: number
  hookCount?: number
  hookInfos?: StopHookInfo[]
  // Absorbed relevant_memories attachments
  relevantMemories?: { path: string; content: string; mtimeMs: number }[]
}

/**
 * A message eligible to be folded into a CollapsedReadSearchGroup: a normalized
 * tool_use / tool_result, or an already-grouped tool-use row.
 * (see utils/collapseReadSearch.ts isCollapsibleToolUse / isCollapsibleToolResult)
 */
export type CollapsibleMessage =
  | NormalizedAssistantMessage
  | NormalizedUserMessage
  | GroupedToolUseMessage

/**
 * The per-turn work-receipt row (render-only, synthetic — like the collapse
 * groups): one dim line summarizing a completed turn's tool activity.
 * Produced by utils/cockpit/turnReceipt.ts (MERCURY_TURN_RECEIPT).
 */
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

/**
 * The union actually handed to the message renderers (MessageRow / Messages):
 * normalized messages plus the render-only grouping rows. Progress messages are
 * NOT renderable rows — they update tool rows via the lookup maps — so they are
 * excluded here (mirrors groupToolUses' `MessageWithoutProgress`).
 */
export type RenderableMessage =
  | NormalizedAssistantMessage
  | NormalizedUserMessage
  | AttachmentMessage
  | SystemMessage
  | GroupedToolUseMessage
  | CollapsedReadSearchGroup
  | TurnReceiptMessage

// ============================================================================
// Query-loop control messages (yielded by query.ts / claude.ts, not rendered
// as transcript rows)
// ============================================================================

/**
 * A raw streaming event surfaced from the API stream. `event` is the SDK beta
 * stream event; `ttftMs` is attached on the message_start event.
 * (see services/providers/anthropic/index.ts producer + QueryEngine.ts consumer)
 */
export type StreamEvent = {
  type: 'stream_event'
  event: ApiStreamEvent
  ttftMs?: number
}

/** Marker yielded when a new API request begins. */
export type RequestStartEvent = {
  type: 'stream_request_start'
}

/**
 * Marks an orphaned (invalid-signature) assistant message for removal from the
 * UI/transcript. (see query.ts tombstone yield)
 */
export type TombstoneMessage = {
  type: 'tombstone'
  message: AssistantMessage
}

/**
 * A coalesced summary of a batch of tool uses, surfaced to SDK consumers.
 * Produced by createToolUseSummaryMessage.
 */
export type ToolUseSummaryMessage = {
  type: 'tool_use_summary'
  summary: string
  precedingToolUseIds: string[]
  uuid: UUID
  timestamp: string
}
