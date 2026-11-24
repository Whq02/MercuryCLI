
type MainThreadSource = 'main_thread'

type SdkSource = 'sdk'

type AgentSource =
  | 'agent:custom'
  | 'agent:default'
  | 'agent:builtin'
  | `agent:builtin:${string}`

export const FOLD_SOURCES = ['compact', 'session_memory', 'away_summary', 'concourse_coordinator_compact'] as const

type FoldSource = (typeof FOLD_SOURCES)[number]

type HookSource = 'hook_agent' | 'hook_prompt'

type ClassifierSource =
  | 'agent_needs_you'
  | 'permission_explainer'
  | 'model_validation'

type UtilitySource =
  | 'side_question'
  | 'verification_agent'
  | 'agent_creation'
  | 'agent_summary'
  | 'generate_session_title'
  | 'rename_generate_name'
  | 'prompt_suggestion'
  | 'feedback'
  | 'mcp_datetime_parse'
  | 'web_search_tool'
  | 'web_fetch_apply'
  | 'overload_probe'
  | 'advisor'
  | 'eval_completion'

export type QuerySource =
  | MainThreadSource
  | SdkSource
  | AgentSource
  | FoldSource
  | HookSource
  | ClassifierSource
  | UtilitySource
