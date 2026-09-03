// ============================================================================
//  src/entrypoints/sdk/controlSchemas.ts — control-protocol request/response
//  schemas and the stdin/stdout aggregate unions. Wire contract; the typed
//  companion is controlTypes.ts (this module is the runtime source of
//  truth). The dependency on coreSchemas.ts is one-directional.
// ============================================================================
import { z } from 'zod/v4'
import { lazySchema } from '../../utils/lazySchema.js'
import {
  PermissionModeSchema,
  PermissionUpdateSchema,
  SDKMessageSchema,
  SDKPostTurnSummaryMessageSchema,
  SDKStreamlinedTextMessageSchema,
  SDKStreamlinedToolUseSummaryMessageSchema,
  SDKUserMessageSchema,
} from './coreSchemas.js'

// ── hook callback wiring ───────────────────────────────────────────────────
export const SDKHookCallbackMatcherSchema = lazySchema(() =>
  z.object({
    matcher: z.string().optional(),
    hookCallbackIds: z.array(z.string()),
    timeout: z.number().optional(),
  }),
)

// ── control request inner subtypes ─────────────────────────────────────────
export const SDKControlInitializeRequestSchema = lazySchema(() =>
  z.object({
    subtype: z.literal('initialize'),
    hooks: z.record(z.string(), z.array(SDKHookCallbackMatcherSchema())).optional(),
    sdkMcpServers: z.array(z.string()).optional(),
    jsonSchema: z.record(z.string(), z.unknown()).optional(),
    systemPrompt: z.string().optional(),
    appendSystemPrompt: z.string().optional(),
    agents: z.record(z.string(), z.unknown()).optional(),
    promptSuggestions: z.boolean().optional(),
    agentProgressSummaries: z.boolean().optional(),
  }),
)
export const SDKControlInterruptRequestSchema = lazySchema(() =>
  z.object({ subtype: z.literal('interrupt') }),
)
export const SDKControlPermissionRequestSchema = lazySchema(() =>
  z.object({
    subtype: z.literal('can_use_tool'),
    tool_name: z.string(),
    input: z.record(z.string(), z.unknown()),
    permission_suggestions: z.array(PermissionUpdateSchema()).optional(),
    blocked_path: z.string().optional(),
    decision_reason: z.string().optional(),
    // The structured reason (decisionReasonWire.ts): a host painting
    // Mercury's own consent card decodes it; any other host ignores it.
    decision_reason_detail: z.unknown().optional(),
    title: z.string().optional(),
    display_name: z.string().optional(),
    tool_use_id: z.string(),
    agent_id: z.string().optional(),
    description: z.string().optional(),
  }),
)
export const SDKControlSetPermissionModeRequestSchema = lazySchema(() =>
  z.object({
    subtype: z.literal('set_permission_mode'),
    mode: PermissionModeSchema(),
    ultraplan: z.boolean().optional(),
  }),
)
export const SDKControlSetModelRequestSchema = lazySchema(() =>
  z.object({ subtype: z.literal('set_model'), model: z.string().optional() }),
)
export const SDKControlSessionFactsRequestSchema = lazySchema(() =>
  z.object({ subtype: z.literal('session_facts') }),
)
export const SDKControlQueueEditRequestSchema = lazySchema(() =>
  z.union([
    z.object({ subtype: z.literal('queue_edit'), op: z.literal('remove'), uuids: z.array(z.string()) }),
    z.object({ subtype: z.literal('queue_edit'), op: z.literal('clear') }),
    z.object({
      subtype: z.literal('queue_edit'),
      op: z.literal('restage'),
      from: z.enum(['now', 'next', 'later']),
      to: z.enum(['now', 'next', 'later']),
    }),
  ]),
)
export const SDKControlSetMaxThinkingTokensRequestSchema = lazySchema(() =>
  z.object({
    subtype: z.literal('set_max_thinking_tokens'),
    max_thinking_tokens: z.number().nullable(),
  }),
)
export const SDKControlMcpStatusRequestSchema = lazySchema(() =>
  z.object({ subtype: z.literal('mcp_status') }),
)
export const SDKControlGetContextUsageRequestSchema = lazySchema(() =>
  z.object({ subtype: z.literal('get_context_usage') }),
)
export const SDKHookCallbackRequestSchema = lazySchema(() =>
  z.object({
    subtype: z.literal('hook_callback'),
    callback_id: z.string(),
    input: z.record(z.string(), z.unknown()),
    tool_use_id: z.string().optional(),
  }),
)
export const SDKControlMcpMessageRequestSchema = lazySchema(() =>
  z.object({
    subtype: z.literal('mcp_message'),
    server_name: z.string(),
    // Placeholder: the MCP JSON-RPC message type is external.
    message: z.unknown(),
  }),
)
export const SDKControlRewindFilesRequestSchema = lazySchema(() =>
  z.object({
    subtype: z.literal('rewind_files'),
    user_message_id: z.string(),
    dry_run: z.boolean().optional(),
  }),
)
export const SDKControlRewindSessionRequestSchema = lazySchema(() =>
  z.object({
    subtype: z.literal('rewind_session'),
    user_message_id: z.string(),
    mode: z.enum(['code', 'conversation', 'both']),
    dry_run: z.boolean().optional(),
  }),
)
export const SDKControlCancelAsyncMessageRequestSchema = lazySchema(() =>
  z.object({
    subtype: z.literal('cancel_async_message'),
    message_uuid: z.string(),
  }),
)
export const SDKControlSeedReadStateRequestSchema = lazySchema(() =>
  z.object({
    subtype: z.literal('seed_read_state'),
    path: z.string(),
    mtime: z.number(),
  }),
)
export const SDKControlMcpSetServersRequestSchema = lazySchema(() =>
  z.object({
    subtype: z.literal('mcp_set_servers'),
    servers: z.record(z.string(), z.unknown()),
  }),
)
export const SDKControlReloadExtensionsRequestSchema = lazySchema(() =>
  z.object({ subtype: z.literal('reload_extensions') }),
)
export const SDKControlMcpReconnectRequestSchema = lazySchema(() =>
  z.object({ subtype: z.literal('mcp_reconnect'), serverName: z.string() }),
)
export const SDKControlMcpToggleRequestSchema = lazySchema(() =>
  z.object({
    subtype: z.literal('mcp_toggle'),
    serverName: z.string(),
    enabled: z.boolean(),
  }),
)
// Mercury: the session-kit forward (the set_effort child-verb
// family). The kit rides unnarrowed — the handler types it through
// validateSessionKit, the mcp_set_servers convention.
export const SDKControlKitEditRequestSchema = lazySchema(() =>
  z.object({ subtype: z.literal('kit_edit'), kit: z.unknown() }),
)
// Mercury: the session's spawn-switch toggle (the kit_edit family) — the
// two switches and their new state, narrowed here (a closed vocabulary).
export const SDKControlSpawnSwitchRequestSchema = lazySchema(() =>
  z.object({
    subtype: z.literal('spawn_switch'),
    switch: z.enum(['subagents', 'workflows']),
    on: z.boolean(),
  }),
)
// Mercury: SATURN's roster push (the kit_edit family). Rows ride unnarrowed
// — the handler shapes them (the mcp_set_servers convention).
export const SDKControlScheduleRosterRequestSchema = lazySchema(() =>
  z.object({ subtype: z.literal('schedule_roster'), schedules: z.unknown() }),
)
export const SDKControlStopTaskRequestSchema = lazySchema(() =>
  z.object({ subtype: z.literal('stop_task'), task_id: z.string() }),
)
export const SDKControlApplyFlagSettingsRequestSchema = lazySchema(() =>
  z.object({
    subtype: z.literal('apply_flag_settings'),
    settings: z.record(z.string(), z.unknown()),
  }),
)
export const SDKControlGetSettingsRequestSchema = lazySchema(() =>
  z.object({ subtype: z.literal('get_settings') }),
)
export const SDKControlElicitationRequestSchema = lazySchema(() =>
  z.object({
    subtype: z.literal('elicitation'),
    mcp_server_name: z.string(),
    message: z.string(),
    mode: z.enum(['form', 'url']).optional(),
    url: z.string().optional(),
    elicitation_id: z.string().optional(),
    requested_schema: z.record(z.string(), z.unknown()).optional(),
    title: z.string().optional(),
  }),
)
/** The SDK's answer to an elicitation control request. */
export const SDKControlElicitationResponseSchema = lazySchema(() =>
  z.object({
    action: z.enum(['accept', 'decline', 'cancel']),
    content: z.record(z.string(), z.unknown()).optional(),
  }),
)

// ── Mercury control subtypes (handled in cli/print.ts) ─────────────────────
export const SDKControlEndSessionRequestSchema = lazySchema(() =>
  z.object({ subtype: z.literal('end_session'), reason: z.string().optional() }),
)
export const SDKControlChannelEnableRequestSchema = lazySchema(() =>
  z.object({ subtype: z.literal('channel_enable'), serverName: z.string() }),
)
export const SDKControlMcpAuthenticateRequestSchema = lazySchema(() =>
  z.object({ subtype: z.literal('mcp_authenticate'), serverName: z.string() }),
)
export const SDKControlMcpOauthCallbackUrlRequestSchema = lazySchema(() =>
  z.object({
    subtype: z.literal('mcp_oauth_callback_url'),
    serverName: z.string(),
    callbackUrl: z.string(),
  }),
)
export const SDKControlMcpClearAuthRequestSchema = lazySchema(() =>
  z.object({ subtype: z.literal('mcp_clear_auth'), serverName: z.string() }),
)
export const SDKControlClaudeAuthenticateRequestSchema = lazySchema(() =>
  z.object({
    subtype: z.literal('claude_authenticate'),
    loginWithClaudeAi: z.boolean().optional(),
  }),
)
export const SDKControlClaudeOauthCallbackRequestSchema = lazySchema(() =>
  z.object({
    subtype: z.literal('claude_oauth_callback'),
    authorizationCode: z.string(),
    state: z.string(),
  }),
)
export const SDKControlClaudeOauthWaitForCompletionRequestSchema = lazySchema(() =>
  z.object({ subtype: z.literal('claude_oauth_wait_for_completion') }),
)
export const SDKControlGenerateSessionTitleRequestSchema = lazySchema(() =>
  z.object({
    subtype: z.literal('generate_session_title'),
    description: z.string(),
    persist: z.boolean().optional(),
  }),
)
export const SDKControlSideQuestionRequestSchema = lazySchema(() =>
  z.object({ subtype: z.literal('side_question'), question: z.string() }),
)
export const SDKControlRemoteControlRequestSchema = lazySchema(() =>
  z.object({ subtype: z.literal('remote_control'), enabled: z.boolean() }),
)

export const SDKControlRequestInnerSchema = lazySchema(() =>
  z.union([
    SDKControlInterruptRequestSchema(),
    SDKControlPermissionRequestSchema(),
    SDKControlInitializeRequestSchema(),
    SDKControlSetPermissionModeRequestSchema(),
    SDKControlSetModelRequestSchema(),
    SDKControlSessionFactsRequestSchema(),
    SDKControlQueueEditRequestSchema(),
    SDKControlSetMaxThinkingTokensRequestSchema(),
    SDKControlMcpStatusRequestSchema(),
    SDKControlGetContextUsageRequestSchema(),
    SDKHookCallbackRequestSchema(),
    SDKControlMcpMessageRequestSchema(),
    SDKControlRewindFilesRequestSchema(),
    SDKControlRewindSessionRequestSchema(),
    SDKControlCancelAsyncMessageRequestSchema(),
    SDKControlSeedReadStateRequestSchema(),
    SDKControlMcpSetServersRequestSchema(),
    SDKControlReloadExtensionsRequestSchema(),
    SDKControlMcpReconnectRequestSchema(),
    SDKControlMcpToggleRequestSchema(),
    SDKControlKitEditRequestSchema(),
    SDKControlSpawnSwitchRequestSchema(),
    SDKControlScheduleRosterRequestSchema(),
    SDKControlStopTaskRequestSchema(),
    SDKControlApplyFlagSettingsRequestSchema(),
    SDKControlGetSettingsRequestSchema(),
    SDKControlElicitationRequestSchema(),
    SDKControlEndSessionRequestSchema(),
    SDKControlChannelEnableRequestSchema(),
    SDKControlMcpAuthenticateRequestSchema(),
    SDKControlMcpOauthCallbackUrlRequestSchema(),
    SDKControlMcpClearAuthRequestSchema(),
    SDKControlClaudeAuthenticateRequestSchema(),
    SDKControlClaudeOauthCallbackRequestSchema(),
    SDKControlClaudeOauthWaitForCompletionRequestSchema(),
    SDKControlGenerateSessionTitleRequestSchema(),
    SDKControlSideQuestionRequestSchema(),
    SDKControlRemoteControlRequestSchema(),
  ]),
)

// ── frames ─────────────────────────────────────────────────────────────────
export const SDKControlRequestSchema = lazySchema(() =>
  z.object({
    type: z.literal('control_request'),
    request_id: z.string(),
    request: SDKControlRequestInnerSchema(),
  }),
)
export const SDKControlCancelRequestSchema = lazySchema(() =>
  z.object({
    type: z.literal('control_cancel_request'),
    request_id: z.string(),
  }),
)
export const ControlResponseSchema = lazySchema(() =>
  z.object({
    subtype: z.literal('success'),
    request_id: z.string(),
    response: z.record(z.string(), z.unknown()).optional(),
    pending_permission_requests: z.array(SDKControlRequestSchema()).optional(),
    pending_user_dialog_requests: z.array(SDKControlRequestSchema()).optional(),
  }),
)
export const ControlErrorResponseSchema = lazySchema(() =>
  z.object({
    subtype: z.literal('error'),
    request_id: z.string(),
    error: z.string(),
    pending_permission_requests: z.array(SDKControlRequestSchema()).optional(),
    pending_user_dialog_requests: z.array(SDKControlRequestSchema()).optional(),
  }),
)
export const SDKControlResponseSchema = lazySchema(() =>
  z.object({
    type: z.literal('control_response'),
    response: z.union([ControlResponseSchema(), ControlErrorResponseSchema()]),
  }),
)
export const SDKKeepAliveMessageSchema = lazySchema(() =>
  z.object({ type: z.literal('keep_alive') }),
)
export const SDKUpdateEnvironmentVariablesMessageSchema = lazySchema(() =>
  z.object({
    type: z.literal('update_environment_variables'),
    variables: z.record(z.string(), z.string()),
  }),
)

// ── aggregate transport unions ─────────────────────────────────────────────
/** Everything the CLI writes to its stdout transport. */
export const StdoutMessageSchema = lazySchema(() =>
  z.union([
    SDKMessageSchema(),
    SDKStreamlinedTextMessageSchema(),
    SDKStreamlinedToolUseSummaryMessageSchema(),
    SDKPostTurnSummaryMessageSchema(),
    SDKControlResponseSchema(),
    SDKControlRequestSchema(),
    SDKControlCancelRequestSchema(),
    SDKKeepAliveMessageSchema(),
  ]),
)
/** Everything the CLI reads from its stdin transport. */
export const StdinMessageSchema = lazySchema(() =>
  z.union([
    SDKUserMessageSchema(),
    SDKControlRequestSchema(),
    SDKControlResponseSchema(),
    SDKKeepAliveMessageSchema(),
    SDKUpdateEnvironmentVariablesMessageSchema(),
  ]),
)
