import type { AssistantMessage, Message } from '../../../types/message.js'
import type { CompatStreamOptions } from './compatChatClient.js'
import { openrouterResponsesInput, replayableOpenrouterItems, streamOpenrouterResponses } from '../openrouter/openrouterResponsesTransport.js'

export function compatResponsesTransport(options: CompatStreamOptions, messages: readonly Message[], endpoint: string) {
  const request = options.request
  const system = request.messages.find(message => message.role === 'system')
  const extra = request.extra ?? {}
  const history = messages.map(message => message.type === 'assistant' ? {
    ...message,
    openrouterProviderTurn: message.compatProviderTurn?.endpoint === endpoint ? message.compatProviderTurn : undefined,
  } : message)
  const body = {
    model: request.model,
    ...(system && 'content' in system && typeof system.content === 'string' ? { instructions: system.content } : {}),
    input: openrouterResponsesInput(history, request.model, options.imagesSupported ?? options.deferral?.imagesSupported ?? true),
    tools: (request.tools ?? []).map(tool => ({ type: 'function', name: tool.function.name, description: tool.function.description, parameters: tool.function.parameters })),
    ...(typeof extra.reasoning_effort === 'string' ? { reasoning: { effort: extra.reasoning_effort } } : {}),
    ...(typeof extra.max_tokens === 'number' ? { max_output_tokens: extra.max_tokens } : {}),
    ...(typeof extra.prompt_cache_key === 'string' ? { prompt_cache_key: extra.prompt_cache_key } : {}),
    include: ['reasoning.encrypted_content'],
    store: false,
    stream: true,
  }
  const state: { model: string; items: unknown[]; responseId?: string } = { model: request.model, items: [] }
  return {
    events: streamOpenrouterResponses(options, JSON.stringify(body), state, 'openai-compat'),
    settle(minted: readonly AssistantMessage[]): void {
      const last = minted.at(-1)
      if (!last) return
      const ids = new Set<string>()
      for (const message of minted) for (const block of message.message.content) if (block.type === 'tool_use') ids.add(block.id)
      const items = replayableOpenrouterItems(state.items, ids)
      if (items.length) last.compatProviderTurn = { ...state, endpoint, items }
    },
  }
}
