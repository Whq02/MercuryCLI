
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

  if (inputs?.hasThinking === true && inputs.isRedactThinkingActive !== true) {
    edits.push(
      inputs.clearAllThinking === true
        ? { type: 'clear_thinking_20251015', keep: { type: 'thinking_turns', value: 1 } }
        : { type: 'clear_thinking_20251015', keep: 'all' },
    )
  }

  if (edits.length === 0) return undefined
  return { edits }

}
