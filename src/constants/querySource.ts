/**
 * QuerySource — the analytics/behavior tag identifying WHICH call path issued a
 * model query.
 *
 * It rides on every API request (`callClaude`/`sideQuery`/agent/compaction call
 * paths) so downstream policy can branch on the origin of a turn: which sources
 * retry on 529 (`withRetry.ts`), which get the 1h prompt-cache TTL
 * (`should1hCacheTTL`), whether a turn is a foreground REPL/SDK turn vs. a
 * background classifier/summary, and so on. Consumers narrow on it with `===`
 * against specific literals (e.g. `=== 'sdk'`, `=== 'compact'`) and with
 * `String.prototype.startsWith` against the open prefixes (`'repl_main_thread'`,
 * `'agent:'`), so the type is a string-literal union — assignable to `string`,
 * keeping `.startsWith()` well-typed while preserving exact-literal narrowing.
 *
 * One member is an OPEN FAMILY, built by interpolation in `promptCategory.ts`:
 *   - `agent:builtin:${agentType}`  — per built-in agent kind
 * It is modeled as a template-literal type so the dynamic casts type-check,
 * while the concrete `agent:builtin:fork` form still appears as a nameable
 * literal for `===` comparisons.
 *
 * This module is imported TYPE-ONLY everywhere; no runtime value is required.
 */

/** Foreground, user-blocking turns. */
type ReplSource = 'repl_main_thread'

/** The Agent-SDK / headless (`-p`) entrypoint. */
type SdkSource = 'sdk'

/**
 * Sub-agent (Task/Agent tool) turns. `agent:builtin:${agentType}` is the open
 * family for built-in agents (e.g. `agent:builtin:fork`); `agent:custom` /
 * `agent:default` cover the custom-prompt and unnamed cases. Bare
 * `agent:builtin` is the family root used for membership tests.
 */
type AgentSource =
  | 'agent:custom'
  | 'agent:default'
  | 'agent:builtin'
  | `agent:builtin:${string}`

/** Context-management / compaction call paths. */
type CompactionSource =
  | 'compact'
  | 'session_memory'
  | 'marble_origami'
  | 'extract_memories'
  | 'memdir_relevance'
  | 'away_summary'
  | 'auto_dream'
  | 'concourse_coordinator_compact'

/** Hook-driven sub-queries. */
type HookSource = 'hook_agent' | 'hook_prompt'

/** Security / permission classifiers (must complete for auto-mode correctness). */
type ClassifierSource =
  | 'auto_mode'
  | 'auto_mode_critique'
  | 'bash_classifier'
  | 'yolo_classifier'
  | 'agent_classifier'
  | 'permission_explainer'
  | 'model_validation'

/**
 * Background utility queries — summaries, titles, suggestions, name generation,
 * tool/MCP helpers. None are user-blocking.
 */
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

/**
 * The full set of recognized query sources. Untagged call paths pass
 * `undefined` (handled at every consumer), so this type does NOT include
 * `undefined` itself.
 */
export type QuerySource =
  | ReplSource
  | SdkSource
  | AgentSource
  | CompactionSource
  | HookSource
  | ClassifierSource
  | UtilitySource
