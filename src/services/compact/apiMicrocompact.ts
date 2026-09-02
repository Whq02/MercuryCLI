/**
 * Builds the server-side context-management directives sent with a request.
 * The thinking-clearing strategy is live; the tool-clearing tail is dead
 * behind an unconditional return and is deliberately not reconstructed.
 */

/** The API's strategy type discriminators — wire contract data. */
export type ContextEditStrategy =
  | {
      type: 'clear_thinking_20251015'
      keep: 'all' | { type: 'thinking_turns'; value: number }
    }
  | {
      type: 'clear_tool_uses_20250919'
      trigger?: { type: 'input_tokens'; value: number }
      keep?: { type: 'tool_uses'; value: number }
      clear_at_least?: { type: 'input_tokens'; value: number }
      clear_tool_inputs?: string[] | boolean
      exclude_tools?: string[]
    }

export type ContextManagementConfig = {
  edits: ContextEditStrategy[]
}

type ContextManagementInputs = {
  hasThinking?: boolean
  isRedactThinkingActive?: boolean
  clearAllThinking?: boolean
}

export function getAPIContextManagement(
  inputs?: ContextManagementInputs,
): ContextManagementConfig | undefined {
  const edits: ContextEditStrategy[] = []

  // Redacted thinking blocks carry no model-visible content, so there is
  // nothing worth clearing when they are active.
  if (inputs?.hasThinking === true && inputs.isRedactThinkingActive !== true) {
    // keep must be a count of 1 when all-clearing is requested — not 0 (the
    // API schema requires at least 1) and not omitted (the model-policy
    // default usually means "all" and would not clear anything).
    // All-clearing is requested when the conversation has been idle past the
    // cache TTL, so the prefix is being rewritten regardless.
    edits.push(
      inputs.clearAllThinking === true
        ? { type: 'clear_thinking_20251015', keep: { type: 'thinking_turns', value: 1 } }
        : { type: 'clear_thinking_20251015', keep: 'all' },
    )
  }

  if (edits.length === 0) return undefined
  return { edits }

  // ------------------------------------------------------------------------
  // The tool-clearing strategies (trigger / clear-at-least thresholds in
  // input tokens, the clearable-tool list for results, the excluded-tool
  // list for uses, and the API_MAX_INPUT_TOKENS / API_TARGET_INPUT_TOKENS /
  // USE_API_CLEAR_TOOL_RESULTS / USE_API_CLEAR_TOOL_USES knobs, defaults
  // 180 000 and 40 000) are unreachable in this build: the return above is
  // unconditional. The exported strategy type keeps the transports
  // type-checking; the construction is deliberately not re-implemented.
  // ------------------------------------------------------------------------
}
