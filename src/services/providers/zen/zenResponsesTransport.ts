import type { AssistantMessage, Message } from '../../../types/message.js'
import type { CompatStreamOptions } from '../openaicompat/compatChatClient.js'
import { openrouterResponsesInput, replayableOpenrouterItems, streamOpenrouterResponses } from '../openrouter/openrouterResponsesTransport.js'
import { xaiProxyToolOutputs } from '../xai/xaiResponsesTransport.js'

export function buildZenResponsesBody(options: CompatStreamOptions, messages: readonly Message[]): Record<string, unknown> {
  const request = options.request
  const system = request.messages.find(message => message.role === 'system')
  const extra = request.extra ?? {}
  const history = messages.map(message => message.type === 'assistant' ? { ...message, openrouterProviderTurn: message.zenProviderTurn } : message)
  return {
    model: request.model,
    ...(system && 'content' in system && typeof system.content === 'string' ? { instructions: system.content } : {}),
    input: xaiProxyToolOutputs(openrouterResponsesInput(history, request.model, options.deferral?.imagesSupported ?? true)),
    tools: (request.tools ?? []).map(tool => ({ type: 'function', name: tool.function.name, description: tool.function.description, parameters: tool.function.parameters })),
    ...(typeof extra.reasoning_effort === 'string' ? { reasoning: { effort: extra.reasoning_effort } } : {}),
    ...(typeof extra.max_completion_tokens === 'number' ? { max_output_tokens: extra.max_completion_tokens } : {}),
    include: ['reasoning.encrypted_content'],
    store: false,
    stream: true,
  }
}

export function zenResponsesTransport(options: CompatStreamOptions, messages: readonly Message[]) {
  const state: { model: string; items: unknown[]; responseId?: string } = { model: options.request.model, items: [] }
  return {
    events: streamOpenrouterResponses(options, JSON.stringify(buildZenResponsesBody(options, messages)), state, 'zen'),
    settle: (minted: readonly AssistantMessage[]): void => {
      const last = minted.at(-1)
      if (!last) return
      const ids = new Set<string>()
      for (const message of minted) for (const block of message.message.content) if (block.type === 'tool_use') ids.add(block.id)
      const items = replayableOpenrouterItems(state.items, ids)
      if (items.length) last.zenProviderTurn = { ...state, items }
    },
  }
}
