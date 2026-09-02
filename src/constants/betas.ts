// ============================================================================
//  src/constants/betas.ts — provider beta-header tokens. The tokens are
//  exact strings the provider API matches; they are the whole content of
//  this module. Contract data.
//
//  Three exports are the empty string — an empty header must be treated as
//  "absent" by consumers, never sent.
// ============================================================================

// The coding-product server beta. The TOKEN is the wire contract the API
// matches byte-exact; only the identifier is Mercury's.
export const CODING_20250219_BETA_HEADER = 'claude-code-20250219'
export const INTERLEAVED_THINKING_BETA_HEADER = 'interleaved-thinking-2025-05-14'
export const CONTEXT_1M_BETA_HEADER = 'context-1m-2025-08-07'
export const CONTEXT_MANAGEMENT_BETA_HEADER = 'context-management-2025-06-27'
export const STRUCTURED_OUTPUTS_BETA_HEADER = 'structured-outputs-2025-12-15'
/** Tool search. */
export const TOOL_SEARCH_BETA_HEADER_1P = 'advanced-tool-use-2025-11-20'
export const EFFORT_BETA_HEADER = 'effort-2025-11-24'
export const TASK_BUDGETS_BETA_HEADER = 'task-budgets-2026-03-13'
export const PROMPT_CACHING_SCOPE_BETA_HEADER = 'prompt-caching-scope-2026-01-05'
export const REDACT_THINKING_BETA_HEADER = 'redact-thinking-2026-02-12'
export const TOKEN_EFFICIENT_TOOLS_BETA_HEADER = 'token-efficient-tools-2026-03-28'
export const ADVISOR_BETA_HEADER = 'advisor-tool-2026-03-01'
/** Preserved-thinking controls: unlocks thinking.block_binding and adds
 *  input_transformations to every thinking-capable response. */
export const THINKING_BINDING_CONTROLS_BETA_HEADER = 'thinking-binding-controls-2026-08-01'
/** Server-side refusal fallback, the `fallbacks: 'default'` form (the
 *  refusals page, fetched 2026-09-01). Opt-in: MERCURY_REFUSAL_FALLBACK. */
export const SERVER_SIDE_FALLBACK_BETA_HEADER = 'server-side-fallback-2026-07-01'

// Empty = absent: consumers must not send these.
export const SUMMARIZE_CONNECTOR_TEXT_BETA_HEADER = ''
export const AFK_MODE_BETA_HEADER = ''
export const CLI_INTERNAL_BETA_HEADER = ''
