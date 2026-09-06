
import type { PermissionMode } from '../../utils/permissions/PermissionMode.js'
import type { PermissionUpdate } from '../../types/permissions.js'
import type { DecisionReasonWireV1 } from '../../utils/permissions/decisionReasonWire.js'


export type SDKHookCallbackMatcher = {
  matcher?: string
  hook_callback_ids: string[]
  timeout?: number
}


export type SDKControlInitializeRequest = {
  subtype: 'initialize'
  hooks?: Record<string, SDKHookCallbackMatcher[]>
  host_mcp_servers?: string[]
  json_schema?: Record<string, unknown>
  system_prompt?: string
  append_system_prompt?: string
  agents?: Record<string, unknown>
  prompt_suggestions?: boolean
  agent_progress_summaries?: boolean
}

export type SDKControlInterruptRequest = {
  subtype: 'interrupt'
}

export type SDKControlPermissionRequest = {
  subtype: 'can_use_tool'
  tool_name: string
  input: Record<string, unknown>
  permission_suggestions?: PermissionUpdate[]
  blocked_path?: string
  decision_reason?: string
  decision_reason_detail?: DecisionReasonWireV1
  title?: string
  display_name?: string
  tool_use_id: string
  agent_id?: string
  description?: string
}

export type SDKControlSetPermissionModeRequest = {
  subtype: 'set_permission_mode'
  mode: PermissionMode
}

export type SDKControlSetModelRequest = {
  subtype: 'set_model'
  model?: string
}

export type SDKControlSessionFactsRequest = {
  subtype: 'session_facts'
}

export type SDKControlQueueEditRequest =
  | { subtype: 'queue_edit'; op: 'remove'; uuids: string[] }
  | { subtype: 'queue_edit'; op: 'clear' }
  | { subtype: 'queue_edit'; op: 'restage'; from: 'now' | 'next' | 'later'; to: 'now' | 'next' | 'later' }

export type SDKControlSetMaxThinkingTokensRequest = {
  subtype: 'set_max_thinking_tokens'
  max_thinking_tokens: number | null
}

export type SDKControlMcpStatusRequest = {
  subtype: 'mcp_status'
}

export type SDKControlGetContextUsageRequest = {
  subtype: 'get_context_usage'
}

export type SDKHookCallbackRequest = {
  subtype: 'hook_callback'
  callback_id: string
  input: Record<string, unknown>
  tool_use_id?: string
}

export type SDKControlMcpMessageRequest = {
  subtype: 'mcp_message'
  server_name: string
  message: unknown
}

export type SDKControlRewindFilesRequest = {
  subtype: 'rewind_files'
  user_message_id: string
  dry_run?: boolean
}

export type SDKControlRewindSessionRequest = {
  subtype: 'rewind_session'
  user_message_id: string
  mode: 'code' | 'conversation' | 'both'
  dry_run?: boolean
}

export type SDKControlCancelAsyncMessageRequest = {
  subtype: 'cancel_async_message'
  message_uuid: string
}

export type SDKControlSeedReadStateRequest = {
  subtype: 'seed_read_state'
  path: string
  mtime: number
}

export type SDKControlMcpSetServersRequest = {
  subtype: 'mcp_set_servers'
  servers: Record<string, unknown>
}

export type SDKControlReloadExtensionsRequest = {
  subtype: 'reload_extensions'
}

export type SDKControlMcpReconnectRequest = {
  subtype: 'mcp_reconnect'
  server_name: string
}

export type SDKControlMcpToggleRequest = {
  subtype: 'mcp_toggle'
  server_name: string
  enabled: boolean
}

export type SDKControlKitEditRequest = {
  subtype: 'kit_edit'
  kit: unknown
}

export type SDKControlSpawnSwitchRequest = {
  subtype: 'spawn_switch'
  switch: 'subagents' | 'workflows'
  on: boolean
}

export type SDKControlScheduleRosterRequest = {
  subtype: 'schedule_roster'
  schedules: unknown
}

export type SDKControlStopTaskRequest = {
  subtype: 'stop_task'
  task_id: string
}

export type SDKControlResumeTaskRequest = {
  subtype: 'resume_task'
  task_id: string
  note?: string
}

export type SDKControlApplyFlagSettingsRequest = {
  subtype: 'apply_flag_settings'
  settings: Record<string, unknown>
}

export type SDKControlGetSettingsRequest = {
  subtype: 'get_settings'
}

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


export type SDKControlEndSessionRequest = {
  subtype: 'end_session'
  reason?: string
}

export type SDKControlMcpAuthenticateRequest = {
  subtype: 'mcp_authenticate'
  server_name: string
}

export type SDKControlMcpOauthCallbackUrlRequest = {
  subtype: 'mcp_oauth_callback_url'
  server_name: string
  callback_url: string
}

export type SDKControlMcpClearAuthRequest = {
  subtype: 'mcp_clear_auth'
  server_name: string
}

export type SDKControlProviderSignInRequest = {
  subtype: 'provider_sign_in'
  provider: string
  method?: 'subscription' | 'console'
}

export type SDKControlProviderSignInCallbackRequest = {
  subtype: 'provider_sign_in_callback'
  authorization_code: string
  state: string
}

export type SDKControlProviderSignInWaitRequest = {
  subtype: 'provider_sign_in_wait'
}

export type SDKControlGenerateSessionTitleRequest = {
  subtype: 'generate_session_title'
  description: string
  persist?: boolean
}

export type SDKControlSideQuestionRequest = {
  subtype: 'side_question'
  question: string
}

export type SDKControlClaimSessionRequest = {
  subtype: 'claim_session'
  session_id: string
  model?: string
  permission_mode?: string
  effort?: string
  resume?: boolean
  openai_catalogue?: {
    source_kind: 'chatgpt-subscription' | 'api-key'
    models: unknown[]
    fetched_at_ms: number
  }
}

export type SDKControlSetEffortRequest = {
  subtype: 'set_effort'
  effort: string
}

export type SDKControlWithdrawSendRequest = {
  subtype: 'withdraw_send'
  client_message_id: string
}

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
  | SDKControlResumeTaskRequest
  | SDKControlApplyFlagSettingsRequest
  | SDKControlGetSettingsRequest
  | SDKControlElicitationRequest
  | SDKControlEndSessionRequest
  | SDKControlMcpAuthenticateRequest
  | SDKControlMcpOauthCallbackUrlRequest
  | SDKControlMcpClearAuthRequest
  | SDKControlProviderSignInRequest
  | SDKControlProviderSignInCallbackRequest
  | SDKControlProviderSignInWaitRequest
  | SDKControlGenerateSessionTitleRequest
  | SDKControlSideQuestionRequest
  | SDKControlClaimSessionRequest
  | SDKControlSetEffortRequest
  | SDKControlWithdrawSendRequest

export type SDKControlRequest = {
  type: 'control_request'
  request_id: string
  request: SDKControlRequestInner
  uuid?: string
}

export type SDKControlCancelRequest = {
  type: 'control_cancel_request'
  request_id: string
}


export type ControlResponse = {
  subtype: 'success'
  request_id: string
  response?: Record<string, unknown>
  pending_permission_requests?: SDKControlRequest[]
  pending_user_dialog_requests?: SDKControlRequest[]
}

export type ControlErrorResponse = {
  subtype: 'error'
  request_id: string
  error: string
  pending_permission_requests?: SDKControlRequest[]
  pending_user_dialog_requests?: SDKControlRequest[]
}

export type SDKControlResponse = {
  type: 'control_response'
  response: ControlResponse | ControlErrorResponse
  uuid?: string
}


export type SDKControlInitializeResponse = {
  commands: unknown[]
  agents: unknown[]
  models: unknown[]
  account: unknown
  pid?: number
}

export type SDKControlMcpSetServersResponse = {
  added: string[]
  removed: string[]
  errors: Record<string, string>
}

export type SDKControlReloadExtensionsResponse = {
  commands: unknown[]
  agents: unknown[]
  extensions: { name: string; path: string; source?: string }[]
  mcp_servers: unknown[]
  error_count: number
}


export type SDKAssistantMessage = {
  type: 'assistant'
  message: { id: string; content: unknown }
  parent_tool_use_id: string | null
  error?: unknown
  uuid: string
  session_id: string
}

export type SDKUserMessage = {
  type: 'user'
  message: { role?: string; content: unknown }
  parent_tool_use_id?: string | null
  uuid?: string
  session_id?: string
  is_replay?: true
  timestamp?: string
  priority?: 'now' | 'next' | 'later'
  mode?: 'prompt' | 'bash' | 'task-notification'
  agent_id?: string
}

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

export type SDKResultMessage = {
  type: 'result'
  subtype?: string
  uuid: string
  session_id: string
  [key: string]: unknown
}

export type SDKSystemMessage = {
  type: 'system'
  subtype?: string
  uuid: string
  session_id: string
  [key: string]: unknown
}

export type SDKToolProgressMessage = {
  type: 'tool_progress'
  uuid: string
  session_id: string
  [key: string]: unknown
}

export type SDKPromptSuggestionMessage = {
  type: 'prompt_suggestion'
  suggestion: string
  uuid: string
  session_id: string
}

export type SDKRateLimitEvent = {
  type: 'rate_limit_event'
  rate_limit_info: unknown
  uuid: string
  session_id: string
}

export type SDKMessage =
  | SDKAssistantMessage
  | SDKUserMessage
  | SDKResultMessage
  | SDKSystemMessage
  | SDKPartialAssistantMessage
  | SDKToolProgressMessage
  | SDKRateLimitEvent
  | SDKPromptSuggestionMessage


export type StdoutMessage =
  | SDKMessage
  | SDKControlResponse
  | SDKControlRequest
  | SDKControlCancelRequest

export type StdinMessage =
  | SDKUserMessage
  | SDKAssistantMessage
  | SDKSystemMessage
  | SDKControlRequest
  | SDKControlResponse
