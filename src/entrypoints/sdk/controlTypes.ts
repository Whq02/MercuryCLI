// SDK Control Types — the control-protocol type surface between SDK
// implementations and the CLI process (permission prompts, session control,
// the stdin/stdout transport framing).
//
// This is the inferred-type companion to the Zod schemas in controlSchemas.ts:
// every shape below mirrors a `*Schema` there (controlSchemas.ts is the runtime
// source of truth; this file is the compile-time surface, erased at build).
// SDK builders import the control protocol from here directly; SDK consumers use
// coreTypes.ts instead.
//
// Note: coreTypes.generated.ts is an empty
// stub, so the broad SDKMessage family cannot be referenced by name. The leaf
// message shapes the aggregate unions below need are therefore defined locally
// (matching coreSchemas.ts) rather than imported from coreTypes.js.

import type { PermissionMode } from '../../utils/permissions/PermissionMode.js'
import type { PermissionUpdate } from '../../types/permissions.js'
import type { DecisionReasonWireV1 } from '../../utils/permissions/decisionReasonWire.js'

// ============================================================================
// Hook callback wiring (SDKControlInitializeRequest.hooks)
// ============================================================================

/** Configuration for matching and routing hook callbacks. */
export type SDKHookCallbackMatcher = {
  matcher?: string
  hookCallbackIds: string[]
  timeout?: number
}

// ============================================================================
// Control request inner subtypes (discriminated on `subtype`)
// ============================================================================

/** Initializes the SDK session with hooks, MCP servers, and agent config. */
export type SDKControlInitializeRequest = {
  subtype: 'initialize'
  hooks?: Record<string, SDKHookCallbackMatcher[]>
  sdkMcpServers?: string[]
  jsonSchema?: Record<string, unknown>
  systemPrompt?: string
  appendSystemPrompt?: string
  agents?: Record<string, unknown>
  promptSuggestions?: boolean
  agentProgressSummaries?: boolean
}

/** Interrupts the currently running conversation turn. */
export type SDKControlInterruptRequest = {
  subtype: 'interrupt'
}

/** Requests permission to use a tool with the given input. */
export type SDKControlPermissionRequest = {
  subtype: 'can_use_tool'
  tool_name: string
  input: Record<string, unknown>
  permission_suggestions?: PermissionUpdate[]
  blocked_path?: string
  decision_reason?: string
  /** The structured reason the consent card explains (the matched rule,
   *  the mode, a hook, a safety check, per-part verdicts). */
  decision_reason_detail?: DecisionReasonWireV1
  title?: string
  display_name?: string
  tool_use_id: string
  agent_id?: string
  description?: string
}

/** Sets the permission mode for tool execution handling. */
export type SDKControlSetPermissionModeRequest = {
  subtype: 'set_permission_mode'
  mode: PermissionMode
  ultraplan?: boolean
}

/** Sets the model to use for subsequent conversation turns. */
export type SDKControlSetModelRequest = {
  subtype: 'set_model'
  model?: string
}

/** Mercury: the session answers its own facts — the model it runs, its
 *  usage, its account identity, its skills and MCP rosters, its permission
 *  mode, its workspace and its queue (the session seat's facts door). */
export type SDKControlSessionFactsRequest = {
  subtype: 'session_facts'
}

/** Mercury: edit the session's own queue — remove entries by uuid, clear
 *  it, or restage the newest prompt between priority bands (the composer's
 *  queue doors, one-to-one). */
export type SDKControlQueueEditRequest =
  | { subtype: 'queue_edit'; op: 'remove'; uuids: string[] }
  | { subtype: 'queue_edit'; op: 'clear' }
  | { subtype: 'queue_edit'; op: 'restage'; from: 'now' | 'next' | 'later'; to: 'now' | 'next' | 'later' }

/** Sets the maximum number of thinking tokens for extended thinking. */
export type SDKControlSetMaxThinkingTokensRequest = {
  subtype: 'set_max_thinking_tokens'
  max_thinking_tokens: number | null
}

/** Requests the current status of all MCP server connections. */
export type SDKControlMcpStatusRequest = {
  subtype: 'mcp_status'
}

/** Requests a breakdown of current context window usage by category. */
export type SDKControlGetContextUsageRequest = {
  subtype: 'get_context_usage'
}

/** Invokes a registered hook callback by id. */
export type SDKHookCallbackRequest = {
  subtype: 'hook_callback'
  callback_id: string
  input: Record<string, unknown>
  tool_use_id?: string
}

/** Sends a JSON-RPC message to a specific MCP server. */
export type SDKControlMcpMessageRequest = {
  subtype: 'mcp_message'
  server_name: string
  message: unknown
}

/** Rewinds file changes made since a specific user message. */
export type SDKControlRewindFilesRequest = {
  subtype: 'rewind_files'
  user_message_id: string
  dry_run?: boolean
}

/** Mercury: the /rewind verb inside the session's own runner — restore the
 *  files to the checkpoint at a user message ('code'), wind the conversation
 *  back to that turn boundary ('conversation'), or both; the answer is the
 *  typed receipt the daemon relays to the cockpit (protocol.ts
 *  SessionRewindOutcomeV1). A dry run reports what a code restore would
 *  touch and writes nothing. */
export type SDKControlRewindSessionRequest = {
  subtype: 'rewind_session'
  user_message_id: string
  mode: 'code' | 'conversation' | 'both'
  dry_run?: boolean
}

/** Cancels an in-flight async (queued) message. */
export type SDKControlCancelAsyncMessageRequest = {
  subtype: 'cancel_async_message'
  // The wire field is `message_uuid` (SDKControlCancelAsyncMessageRequestSchema in
  // controlSchemas.ts is the wire truth; print.ts reads `message_uuid`). The type
  // must say `message_uuid` — a `message_id` spelling matches no schema or producer.
  message_uuid: string
}

/** Seeds the readFileState cache with a path+mtime entry. */
export type SDKControlSeedReadStateRequest = {
  subtype: 'seed_read_state'
  path: string
  mtime: number
}

/** Replaces the set of dynamically managed MCP servers. */
export type SDKControlMcpSetServersRequest = {
  subtype: 'mcp_set_servers'
  servers: Record<string, unknown>
}

/** Reloads the extensions from disk and returns the refreshed session components. */
export type SDKControlReloadExtensionsRequest = {
  subtype: 'reload_extensions'
}

/** Reconnects a disconnected or failed MCP server. */
export type SDKControlMcpReconnectRequest = {
  subtype: 'mcp_reconnect'
  serverName: string
}

/** Enables or disables an MCP server. */
export type SDKControlMcpToggleRequest = {
  subtype: 'mcp_toggle'
  serverName: string
  enabled: boolean
}

/** Mercury: applies a SESSION-KIT edit to the live session — the daemon's
 *  forward of the record writer's post-edit kit (sessionControl 'set-kit',
 *  ledger L24(3): /mcp + /skills are the session's own dials). The child
 *  flips its latch, reconciles the catalogue MCP plane to the new
 *  membership, and re-derives its command table. The landed child-verb
 *  family precedent: `set_effort`/`session_facts`/`queue_edit` — Mercury's
 *  own additions to the SDK child wire. The kit payload is narrowed by the
 *  handler (daemon/sessionKit.ts validateSessionKit), not the schema — the
 *  mcp_set_servers convention. */
export type SDKControlKitEditRequest = {
  subtype: 'kit_edit'
  kit: unknown
}

/** Mercury: the session's SPAWN-SWITCH toggle (daemon → child; the
 *  kit_edit family): the seat's settlement owner landed the operator's
 *  /subagents or /workflows toggle on the record and forwards it — the
 *  child moves its own switch (services/switchboard/spawnSwitches.ts),
 *  the Agent or Workflow tool leaves or rejoins the roster from the next
 *  request, and a roster-transition row marks the lawful prefix change. */
export type SDKControlSpawnSwitchRequest = {
  subtype: 'spawn_switch'
  switch: 'subagents' | 'workflows'
  on: boolean
}

/** SATURN's roster push (the kit_edit family — daemon → child): after the
 *  seat applies the session's own schedule edits, the post-apply roster
 *  rides down so the list/remove tools speak real ids. Rows narrowed by
 *  the handler (the mcp_set_servers convention). */
export type SDKControlScheduleRosterRequest = {
  subtype: 'schedule_roster'
  schedules: unknown
}

/** Stops a running background task. */
export type SDKControlStopTaskRequest = {
  subtype: 'stop_task'
  task_id: string
}

/** Applies a set of feature-flag overrides at runtime. */
export type SDKControlApplyFlagSettingsRequest = {
  subtype: 'apply_flag_settings'
  settings: Record<string, unknown>
}

/** Requests the current resolved settings. */
export type SDKControlGetSettingsRequest = {
  subtype: 'get_settings'
}

/** Requests the SDK consumer to handle an MCP elicitation. */
export type SDKControlElicitationRequest = {
  subtype: 'elicitation'
  mcp_server_name: string
  message: string
  mode?: 'form' | 'url'
  url?: string
  elicitation_id?: string
  requested_schema?: Record<string, unknown>
  title?: string
}

// ── Mercury control subtypes ──────────────────────────────────────
// Mercury's control-request payloads handled in cli/print.ts (the -p /
// remote control loop). Not part of the upstream SDK control surface; field
// shapes are derived from the print.ts consumers (the sender is the external
// SDK client, so there is no in-repo construction site).

/** Mercury: ends the active -p control session. */
export type SDKControlEndSessionRequest = {
  subtype: 'end_session'
  reason?: string
}

/** Mercury: enables a channel-backed MCP server (the coordination substrate). */
export type SDKControlChannelEnableRequest = {
  subtype: 'channel_enable'
  serverName: string
}

/** Mercury: begins interactive auth for an MCP server. */
export type SDKControlMcpAuthenticateRequest = {
  subtype: 'mcp_authenticate'
  serverName: string
}

/** Mercury: submits a manual OAuth callback URL for an MCP server. */
export type SDKControlMcpOauthCallbackUrlRequest = {
  subtype: 'mcp_oauth_callback_url'
  serverName: string
  callbackUrl: string
}

/** Mercury: clears stored auth for an MCP server. */
export type SDKControlMcpClearAuthRequest = {
  subtype: 'mcp_clear_auth'
  serverName: string
}

/** Mercury: begins Anthropic OAuth over the control channel. */
export type SDKControlClaudeAuthenticateRequest = {
  subtype: 'claude_authenticate'
  loginWithClaudeAi?: boolean
}

/** Mercury: injects a manual Anthropic OAuth code/state. */
export type SDKControlClaudeOauthCallbackRequest = {
  subtype: 'claude_oauth_callback'
  authorizationCode: string
  state: string
}

/** Mercury: waits for the active Anthropic OAuth flow to complete. */
export type SDKControlClaudeOauthWaitForCompletionRequest = {
  subtype: 'claude_oauth_wait_for_completion'
}

/** Mercury: generates (and optionally persists) an AI session title. */
export type SDKControlGenerateSessionTitleRequest = {
  subtype: 'generate_session_title'
  description: string
  persist?: boolean
}

/** Mercury: forks a cache-safe side-question agent. */
export type SDKControlSideQuestionRequest = {
  subtype: 'side_question'
  question: string
}

/** Mercury: toggles the remote-control bridge. */
export type SDKControlRemoteControlRequest = {
  subtype: 'remote_control'
  enabled: boolean
}

/** Mercury: the warm-runner claim (daemon/warmRunner.ts) — hands an
 *  identityless warm runner its durable session id, model, permission
 *  posture and effort in ONE atomic control BEFORE the first turn. The
 *  runner acknowledges, and only then does the daemon mint the record and
 *  deliver the words. */
export type SDKControlClaimSessionRequest = {
  subtype: 'claim_session'
  session_id: string
  model?: string
  permission_mode?: string
  effort?: string
  /** THE REACTIVATE ON THE WARM ROAD: the id names a PARKED session with a
   *  transcript — the runner loads it exactly as a cold `--resume` boot
   *  would, before it acks, so a claimed runner is indistinguishable from a
   *  cold --resume spawn. */
  resume?: boolean
}

/** Mercury: sets the session's effort in place — the sibling of
 *  `set_model`/`set_permission_mode` (the daemon-hosted seat's effort verb;
 *  a cold spawn pins the same value via its effort env stamp). */
export type SDKControlSetEffortRequest = {
  subtype: 'set_effort'
  effort: string
}

/**
 * The discriminated union of every control-request payload. Narrow on
 * `subtype`; `'can_use_tool'` narrows to {@link SDKControlPermissionRequest}.
 */
export type SDKControlRequestInner =
  | SDKControlInterruptRequest
  | SDKControlPermissionRequest
  | SDKControlInitializeRequest
  | SDKControlSetPermissionModeRequest
  | SDKControlSetModelRequest
  | SDKControlSessionFactsRequest
  | SDKControlQueueEditRequest
  | SDKControlSetMaxThinkingTokensRequest
  | SDKControlMcpStatusRequest
  | SDKControlGetContextUsageRequest
  | SDKHookCallbackRequest
  | SDKControlMcpMessageRequest
  | SDKControlRewindFilesRequest
  | SDKControlRewindSessionRequest
  | SDKControlCancelAsyncMessageRequest
  | SDKControlSeedReadStateRequest
  | SDKControlMcpSetServersRequest
  | SDKControlReloadExtensionsRequest
  | SDKControlMcpReconnectRequest
  | SDKControlMcpToggleRequest
  | SDKControlKitEditRequest
  | SDKControlSpawnSwitchRequest
  | SDKControlScheduleRosterRequest
  | SDKControlStopTaskRequest
  | SDKControlApplyFlagSettingsRequest
  | SDKControlGetSettingsRequest
  | SDKControlElicitationRequest
  | SDKControlEndSessionRequest
  | SDKControlChannelEnableRequest
  | SDKControlMcpAuthenticateRequest
  | SDKControlMcpOauthCallbackUrlRequest
  | SDKControlMcpClearAuthRequest
  | SDKControlClaudeAuthenticateRequest
  | SDKControlClaudeOauthCallbackRequest
  | SDKControlClaudeOauthWaitForCompletionRequest
  | SDKControlGenerateSessionTitleRequest
  | SDKControlSideQuestionRequest
  | SDKControlRemoteControlRequest
  | SDKControlClaimSessionRequest
  | SDKControlSetEffortRequest

/** A control_request frame on the transport. */
export type SDKControlRequest = {
  type: 'control_request'
  request_id: string
  request: SDKControlRequestInner
  /** Lifecycle stamp some producers ride on the frame. */
  uuid?: string
}

/** Cancels a currently open control request. */
export type SDKControlCancelRequest = {
  type: 'control_cancel_request'
  request_id: string
}

// ============================================================================
// Control responses
// ============================================================================

/** Successful control response. */
export type ControlResponse = {
  subtype: 'success'
  request_id: string
  response?: Record<string, unknown>
  pending_permission_requests?: SDKControlRequest[]
  pending_user_dialog_requests?: SDKControlRequest[]
}

/** Error control response. */
export type ControlErrorResponse = {
  subtype: 'error'
  request_id: string
  error: string
  pending_permission_requests?: SDKControlRequest[]
  pending_user_dialog_requests?: SDKControlRequest[]
}

/** A control_response frame on the transport. */
export type SDKControlResponse = {
  type: 'control_response'
  response: ControlResponse | ControlErrorResponse
  /** Lifecycle stamp some producers ride on the frame. */
  uuid?: string
}

// ----------------------------------------------------------------------------
// Control response payloads referenced by name by the CLI
// ----------------------------------------------------------------------------

/** Response from session initialization. */
export type SDKControlInitializeResponse = {
  commands: unknown[]
  agents: unknown[]
  models: unknown[]
  account: unknown
  pid?: number
}

/** Result of replacing the set of dynamically managed MCP servers. */
export type SDKControlMcpSetServersResponse = {
  added: string[]
  removed: string[]
  errors: Record<string, string>
}

/** Refreshed commands, agents, extensions, and MCP status after reload. */
export type SDKControlReloadExtensionsResponse = {
  commands: unknown[]
  agents: unknown[]
  extensions: { name: string; path: string; source?: string }[]
  mcpServers: unknown[]
  error_count: number
}

// ============================================================================
// Transport keep-alive / env framing
// ============================================================================

/** Keep-alive message to maintain a WebSocket connection. */
export type SDKKeepAliveMessage = {
  type: 'keep_alive'
}

/** Updates environment variables at runtime. */
export type SDKUpdateEnvironmentVariablesMessage = {
  type: 'update_environment_variables'
  variables: Record<string, string>
}

// ============================================================================
// Leaf message shapes for the aggregate stdin/stdout unions
// ----------------------------------------------------------------------------
// coreTypes.generated.ts is an empty stub, so the
// SDKMessage family is reconstructed locally here from coreSchemas.ts. Only the
// fields the in-repo consumers narrow/read are modelled precisely; the message
// `content` payloads stay `unknown` because consumers treat them opaquely (the
// streamlined transformer reads `message.message.content` then array-checks it).
// ============================================================================

/** An assistant turn. `message` is the wire API message (id + content). */
export type SDKAssistantMessage = {
  type: 'assistant'
  message: { id: string; content: unknown }
  parent_tool_use_id: string | null
  error?: unknown
  uuid: string
  session_id: string
}

/** A user turn. `isReplay` marks a message re-emitted from history. */
export type SDKUserMessage = {
  type: 'user'
  message: { role?: string; content: unknown }
  parent_tool_use_id?: string | null
  uuid?: string
  session_id?: string
  isReplay?: true
  timestamp?: string
  /** Queue-priority stamp on harness-injected user frames. */
  priority?: 'now' | 'next' | 'later'
  /** The composer mode the words were typed in, on harness-injected user
   *  frames: a bash line runs as a shell command in the session's own
   *  process, exactly as the in-process composer runs it;
   *  'task-notification' is the delivery door's ADDRESSED form — a note
   *  to one agent inside this session's runner (agentId names it). */
  mode?: 'prompt' | 'bash' | 'task-notification'
  /** mode 'task-notification': the target agent's drain-scope id. */
  agentId?: string
}

/**
 * A streaming partial-assistant delta event. `event` is an Anthropic
 * RawMessageStreamEvent — a union discriminated on `event.type`. Only the two
 * variants the CCR stream coalescer reads (`message_start` → message.id,
 * `content_block_delta` → index + delta) are modelled with their concrete
 * fields; the remaining lifecycle variants share the open base.
 */
export type SDKStreamRawEvent =
  | {
      type: 'message_start'
      message: { id: string; [key: string]: unknown }
    }
  | {
      type: 'content_block_delta'
      index: number
      delta: { type: string; text: string; [key: string]: unknown }
    }
  | {
      type:
        | 'message_delta'
        | 'message_stop'
        | 'content_block_start'
        | 'content_block_stop'
        | 'ping'
      [key: string]: unknown
    }

export type SDKPartialAssistantMessage = {
  type: 'stream_event'
  event: SDKStreamRawEvent
  parent_tool_use_id: string | null
  uuid: string
  session_id: string
}

/** Streamlined text replacement for an assistant message. */
export type SDKStreamlinedTextMessage = {
  type: 'streamlined_text'
  text: string
  session_id: string
  uuid: string
}

/** Streamlined cumulative tool-use summary. */
export type SDKStreamlinedToolUseSummaryMessage = {
  type: 'streamlined_tool_use_summary'
  tool_summary: string
  session_id: string
  uuid: string
}

/**
 * A terminal result message. Result envelopes are subtype-discriminated and
 * carry subtype-specific payload fields (`duration_ms`, `result`, usage…), so
 * the extra payload is modelled as an open `unknown`-valued tail rather than a
 * single fixed shape.
 */
export type SDKResultMessage = {
  type: 'result'
  subtype?: string
  uuid: string
  session_id: string
  [key: string]: unknown
}

/**
 * A system / control-plane envelope (status, hook lifecycle, bridge state,
 * elicitation, task progress…). The `subtype` selects which extra fields are
 * present; the open `unknown`-valued tail carries that subtype-specific data.
 */
export type SDKSystemMessage = {
  type: 'system'
  subtype?: string
  uuid: string
  session_id: string
  [key: string]: unknown
}

/** A tool-progress event. */
export type SDKToolProgressMessage = {
  type: 'tool_progress'
  uuid: string
  session_id: string
  [key: string]: unknown
}

/** An auth-status event. */
export type SDKAuthStatusMessage = {
  type: 'auth_status'
  isAuthenticating: boolean
  uuid: string
  session_id: string
  [key: string]: unknown
}

/** A prompt-suggestion push event. */
export type SDKPromptSuggestionMessage = {
  type: 'prompt_suggestion'
  suggestion: string
  uuid: string
  session_id: string
}

/** A rate-limit event. */
export type SDKRateLimitEvent = {
  type: 'rate_limit_event'
  rate_limit_info: unknown
  uuid: string
  session_id: string
}

/** A post-turn summary message. */
export type SDKPostTurnSummaryMessage = {
  type: 'post_turn_summary'
  uuid: string
  session_id: string
}

/**
 * The full message union carried on the wire. A faithful local reconstruction
 * of coreSchemas.ts's SDKMessage plus the streaming/streamlined/control members
 * the transport multiplexes.
 */
export type SDKMessage =
  | SDKAssistantMessage
  | SDKUserMessage
  | SDKResultMessage
  | SDKSystemMessage
  | SDKPartialAssistantMessage
  | SDKToolProgressMessage
  | SDKAuthStatusMessage
  | SDKRateLimitEvent
  | SDKPromptSuggestionMessage

// ============================================================================
// Aggregate transport message unions
// ============================================================================

/** Everything the CLI writes to its stdout transport. */
export type StdoutMessage =
  | SDKMessage
  | SDKStreamlinedTextMessage
  | SDKStreamlinedToolUseSummaryMessage
  | SDKPostTurnSummaryMessage
  | SDKControlResponse
  | SDKControlRequest
  | SDKControlCancelRequest
  | SDKKeepAliveMessage

/** Everything the CLI reads from its stdin transport. Replay-mode stdin
 *  also carries transcript assistant/system frames. */
export type StdinMessage =
  | SDKUserMessage
  | SDKAssistantMessage
  | SDKSystemMessage
  | SDKControlRequest
  | SDKControlResponse
  | SDKKeepAliveMessage
  | SDKUpdateEnvironmentVariablesMessage
