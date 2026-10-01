import type { AssistantMessage, Message } from '../../../types/message.js'
import type { CompatStreamOptions } from '../openaicompat/compatChatClient.js'
import { openrouterResponsesInput, replayableOpenrouterItems, streamOpenrouterResponses } from '../openrouter/openrouterResponsesTransport.js'

type Row = Record<string, unknown>
const row = (value: unknown): Row | undefined => typeof value === 'object' && value !== null ? value as Row : undefined

export function xaiProxyToolOutputs(input: readonly unknown[]): unknown[] {
  const out: unknown[] = []
  let carrier: Row[] = []
  input.forEach((item, index) => {
    const record = row(item)
    if (record?.type !== 'function_call_output') { out.push(item); return }
    if (Array.isArray(record.output)) {
      const parts = record.output.map(row).filter((part): part is Row => part !== undefined)
      const text = parts.filter(part => part.type === 'input_text' && typeof part.text === 'string').map(part => part.text as string).join('')
      const images = parts.filter(part => part.type === 'input_image')
      if (images.length) carrier.push({ type: 'input_text', text: `Image(s) from tool result ${String(record.call_id ?? '')}:` }, ...images)
      out.push({ ...record, output: text || (images.length ? '(see attached image)' : '') })
    } else out.push(item)
    if (carrier.length && row(input[index + 1])?.type !== 'function_call_output') {
      out.push({ type: 'message', role: 'user', content: carrier })
      carrier = []
    }
  })
  return out
}

export function buildXaiResponsesBody(options: CompatStreamOptions, messages: readonly Message[]): Record<string, unknown> {
  const request = options.request
  const system = request.messages.find(message => message.role === 'system')
  const extra = request.extra ?? {}
  const history = messages.map(message => message.type === 'assistant' ? { ...message, openrouterProviderTurn: message.xaiProviderTurn } : message)
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
export function xaiResponsesTransport(options: CompatStreamOptions, messages: readonly Message[]) {
  const state: { model: string; items: unknown[]; responseId?: string } = { model: options.request.model, items: [] }
  return {
    events: streamOpenrouterResponses(options, JSON.stringify(buildXaiResponsesBody(options, messages)), state, 'xai'),
    settle: (minted: readonly AssistantMessage[]): void => {
      const last = minted.at(-1)
      if (!last) return
      const ids = new Set<string>()
      for (const message of minted) for (const block of message.message.content) if (block.type === 'tool_use') ids.add(block.id)
      const items = replayableOpenrouterItems(state.items, ids)
      if (items.length) last.xaiProviderTurn = { ...state, items }
    },
  }
}
