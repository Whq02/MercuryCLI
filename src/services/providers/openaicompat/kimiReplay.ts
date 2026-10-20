import { z } from 'zod/v4'
import type { Message } from '../../../types/message.js'
import { storedBlocksOf } from '../../../rows/content.js'
import { KIMI_K3_MODELS } from '../moonshot/kimiPins.js'
import type { ZaiWireMessage } from '../zai/zaiClient.js'

export function isKimiK3WireModel(model: string): boolean {
  const id = model.toLowerCase()
  return KIMI_K3_MODELS.has(id) || id === 'moonshotai/kimi-k3'
}

export function kimiReplayProjection(content: unknown): string {
  return JSON.stringify(storedBlocksOf(content).map(block => block.type === 'thinking' ? { type: block.type, thinking: block.thinking } : block.type === 'text' ? { type: block.type, text: block.text } : block.type === 'tool_use' ? { type: block.type, id: block.id, name: block.name, input: block.input } : block))
}

const assistantSchema = z.object({
  role: z.literal('assistant'),
  content: z.string().nullable(),
  reasoning_content: z.string().optional(),
  tool_calls: z.array(z.object({ id: z.string(), type: z.literal('function'), function: z.object({ name: z.string(), arguments: z.string() }) })).optional(),
})

export function replayKimiHistory(mapped: ZaiWireMessage[], messages: readonly Message[], model: string, endpoint: string): ZaiWireMessage[] {
  if (!isKimiK3WireModel(model)) return mapped
  const assistants = messages.filter(message => message.type === 'assistant')
  let index = 0
  return mapped.map(row => {
    if (row.role !== 'assistant') return row
    const message = assistants[index++]
    const replay = message?.kimiProviderTurn
    if (!replay || replay.model !== model || replay.endpoint !== endpoint || replay.projection !== kimiReplayProjection(message.message.content)) return row
    const parsed = assistantSchema.safeParse(replay.assistant)
    return parsed.success ? parsed.data : row
  })
}
