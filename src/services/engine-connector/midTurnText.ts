import { randomUUID } from 'node:crypto'
import type { Message } from '../../types/message.js'
import type { TextPhase } from '../../types/wire.js'

export interface CommittedTextRow {
  seq: number
  sinceMs: number
  atMs: number
  messageId: string
  text: string
  row: Message
}

const EMPTY_USAGE = {
  input_tokens: 0,
  output_tokens: 0,
  cache_creation: null,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
  inference_geo: null,
  iterations: null,
  output_tokens_details: null,
  server_tool_use: null,
  service_tier: null,
  speed: null,
}

export function createTextRow(args: { messageId: string; text: string; phase: TextPhase | null; atMs: number; model: string }): Message {
  return {
    type: 'assistant',
    uuid: randomUUID(),
    timestamp: new Date(args.atMs).toISOString(),
    requestId: undefined,
    isVirtual: true,
    message: {
      id: args.messageId,
      container: null,
      role: 'assistant',
      type: 'message',
      model: args.model,
      content: [{ type: 'text', text: args.text, ...(args.phase !== null ? { phase: args.phase } : {}) }],
      stop_reason: null,
      stop_sequence: null,
      context_management: null,
      usage: EMPTY_USAGE,
    },
  } as unknown as Message
}

export function textRowLanded(row: Message, messageId: string, text: string): boolean {
  if (row.type !== 'assistant') return false
  const message = (row as { message?: { id?: unknown; content?: unknown } }).message
  if (message?.id !== messageId) return false
  const content = message.content
  if (typeof content === 'string') return content.startsWith(text)
  if (!Array.isArray(content)) return false
  return content.some(block => {
    const b = block as { type?: unknown; text?: unknown } | null
    return b?.type === 'text' && typeof b.text === 'string' && b.text.startsWith(text)
  })
}
