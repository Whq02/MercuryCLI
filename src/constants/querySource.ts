
type ReplSource = 'repl_main_thread'

type SdkSource = 'sdk'

type AgentSource =
  | 'agent:custom'
  | 'agent:default'
  | 'agent:builtin'
  | `agent:builtin:${string}`

type CompactionSource =
  | 'compact'
  | 'session_memory'
  | 'marble_origami'
  | 'extract_memories'
  | 'memdir_relevance'
  | 'away_summary'
  | 'auto_dream'
  | 'concourse_coordinator_compact'

type HookSource = 'hook_agent' | 'hook_prompt'

type ClassifierSource =
  | 'auto_mode'
  | 'auto_mode_critique'
  | 'bash_classifier'
  | 'yolo_classifier'
  | 'agent_classifier'
  | 'permission_explainer'
  | 'model_validation'

type UtilitySource =
  | 'side_question'
  | 'speculation'
  | 'verification_agent'
  | 'agent_creation'
  | 'agent_summary'
  | 'tool_use_summary_generation'
  | 'generate_session_title'
  | 'rename_generate_name'
  | 'session_search'
  | 'prompt_suggestion'
  | 'skill_improvement'
  | 'skill_improvement_apply'
  | 'insights'
  | 'tabula_minerva'
  | 'concourse_coordinator'
  | 'tabula_minerva_chat'
  | 'feedback'
  | 'magic_docs'
  | 'bash_extract_prefix'
  | 'mcp_datetime_parse'
  | 'web_search_tool'
  | 'web_fetch_apply'

export type QuerySource =
  | ReplSource
  | SdkSource
  | AgentSource
  | CompactionSource
  | HookSource
  | ClassifierSource
  | UtilitySource
