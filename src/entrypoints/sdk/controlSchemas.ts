import { z } from 'zod/v4'
import { lazySchema } from '../../utils/lazySchema.js'
import {
  PermissionModeSchema,
  PermissionUpdateSchema,
  SDKMessageSchema,
  SDKUserMessageSchema,
} from './coreSchemas.js'

export const SDKHookCallbackMatcherSchema = lazySchema(() =>
  z.object({
    matcher: z.string().optional(),
    hook_callback_ids: z.array(z.string()),
    timeout: z.number().optional(),
  }),
)

export const SDKControlInitializeRequestSchema = lazySchema(() =>
  z.object({
    subtype: z.literal('initialize'),
    hooks: z.record(z.string(), z.array(SDKHookCallbackMatcherSchema())).optional(),
    host_mcp_servers: z.array(z.string()).optional(),
    json_schema: z.record(z.string(), z.unknown()).optional(),
    system_prompt: z.string().optional(),
    append_system_prompt: z.string().optional(),
    agents: z.record(z.string(), z.unknown()).optional(),
    prompt_suggestions: z.boolean().optional(),
    agent_progress_summaries: z.boolean().optional(),
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
  z.object({ subtype: z.literal('mcp_reconnect'), server_name: z.string() }),
)
export const SDKControlMcpToggleRequestSchema = lazySchema(() =>
  z.object({
    subtype: z.literal('mcp_toggle'),
    server_name: z.string(),
    enabled: z.boolean(),
  }),
)
export const SDKControlKitEditRequestSchema = lazySchema(() =>
  z.object({ subtype: z.literal('kit_edit'), kit: z.unknown() }),
)
export const SDKControlSpawnSwitchRequestSchema = lazySchema(() =>
  z.object({
    subtype: z.literal('spawn_switch'),
    switch: z.enum(['subagents', 'workflows']),
    on: z.boolean(),
  }),
)
export const SDKControlScheduleRosterRequestSchema = lazySchema(() =>
  z.object({ subtype: z.literal('schedule_roster'), schedules: z.unknown() }),
)
export const SDKControlStopTaskRequestSchema = lazySchema(() =>
  z.object({ subtype: z.literal('stop_task'), task_id: z.string() }),
)
export const SDKControlResumeTaskRequestSchema = lazySchema(() =>
  z.object({ subtype: z.literal('resume_task'), task_id: z.string(), note: z.string().optional() }),
)
export const SDKControlQuiesceRequestSchema = lazySchema(() =>
  z.object({ subtype: z.literal('quiesce'), action: z.enum(['prepare', 'commit', 'cancel']), token: z.string() }),
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
export const SDKControlElicitationResponseSchema = lazySchema(() =>
  z.object({
    action: z.enum(['accept', 'decline', 'cancel']),
    content: z.record(z.string(), z.unknown()).optional(),
  }),
)

export const SDKControlEndSessionRequestSchema = lazySchema(() =>
  z.object({ subtype: z.literal('end_session'), reason: z.string().optional() }),
)
export const SDKControlMcpAuthenticateRequestSchema = lazySchema(() =>
  z.object({ subtype: z.literal('mcp_authenticate'), server_name: z.string() }),
)
export const SDKControlMcpOauthCallbackUrlRequestSchema = lazySchema(() =>
  z.object({
    subtype: z.literal('mcp_oauth_callback_url'),
    server_name: z.string(),
    callback_url: z.string(),
  }),
)
export const SDKControlMcpClearAuthRequestSchema = lazySchema(() =>
  z.object({ subtype: z.literal('mcp_clear_auth'), server_name: z.string() }),
)
export const SDKControlProviderSignInRequestSchema = lazySchema(() =>
  z.object({
    subtype: z.literal('provider_sign_in'),
    provider: z.string(),
    method: z.enum(['subscription', 'console']).optional(),
  }),
)
export const SDKControlProviderSignInCallbackRequestSchema = lazySchema(() =>
  z.object({
    subtype: z.literal('provider_sign_in_callback'),
    authorization_code: z.string(),
    state: z.string(),
  }),
)
export const SDKControlProviderSignInWaitRequestSchema = lazySchema(() =>
  z.object({ subtype: z.literal('provider_sign_in_wait') }),
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
    SDKControlResumeTaskRequestSchema(),
    SDKControlQuiesceRequestSchema(),
    SDKControlApplyFlagSettingsRequestSchema(),
    SDKControlGetSettingsRequestSchema(),
    SDKControlElicitationRequestSchema(),
    SDKControlEndSessionRequestSchema(),
    SDKControlMcpAuthenticateRequestSchema(),
    SDKControlMcpOauthCallbackUrlRequestSchema(),
    SDKControlMcpClearAuthRequestSchema(),
    SDKControlProviderSignInRequestSchema(),
    SDKControlProviderSignInCallbackRequestSchema(),
    SDKControlProviderSignInWaitRequestSchema(),
    SDKControlGenerateSessionTitleRequestSchema(),
    SDKControlSideQuestionRequestSchema(),
  ]),
)

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

export const StdoutMessageSchema = lazySchema(() =>
  z.union([
    SDKMessageSchema(),
    SDKControlResponseSchema(),
    SDKControlRequestSchema(),
    SDKControlCancelRequestSchema(),
  ]),
)
export const StdinMessageSchema = lazySchema(() =>
  z.union([
    SDKUserMessageSchema(),
    SDKControlRequestSchema(),
    SDKControlResponseSchema(),
  ]),
)
