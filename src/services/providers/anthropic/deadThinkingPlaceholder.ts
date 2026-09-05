
export const DEAD_THINKING_PLACEHOLDER = '[reasoning the API dropped — not carried forward]'

export function isDeadThinkingPlaceholder(block: unknown): boolean {
  return (
    typeof block === 'object' &&
    block !== null &&
    (block as { type?: unknown }).type === 'text' &&
    (block as { text?: unknown }).text === DEAD_THINKING_PLACEHOLDER
  )
}
