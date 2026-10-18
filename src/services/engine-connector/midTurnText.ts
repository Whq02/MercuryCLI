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

const NOTHING_SPENT = {
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

const textBlock = (text: string, phase: TextPhase | null) => (phase === null ? { type: 'text', text } : { type: 'text', text, phase })

export function createTextRow({ messageId, text, phase, atMs, model }: { messageId: string; text: string; phase: TextPhase | null; atMs: number; model: string }): Message {
  const message = {
    id: messageId,
    container: null,
    role: 'assistant',
    type: 'message',
    model,
    content: [textBlock(text, phase)],
    stop_reason: null,
    stop_sequence: null,
    context_management: null,
    usage: NOTHING_SPENT,
  }
  return { type: 'assistant', uuid: randomUUID(), timestamp: new Date(atMs).toISOString(), requestId: undefined, isVirtual: true, message } as unknown as Message
}

const textsOf = (content: unknown): string[] => {
  if (typeof content === 'string') return [content]
  if (!Array.isArray(content)) return []
  return content.flatMap(block => {
    const candidate = block as { type?: unknown; text?: unknown } | null
    return candidate?.type === 'text' && typeof candidate.text === 'string' ? [candidate.text] : []
  })
}

export function textRowLanded(row: Message, messageId: string, text: string): boolean {
  const message = row.type === 'assistant' ? (row as { message?: { id?: unknown; content?: unknown } }).message : undefined
  return message?.id === messageId && textsOf(message.content).some(landed => landed.startsWith(text))
}

function retractedReply(row: Message): boolean {
  return row.type === 'assistant' && (row as { retracted?: unknown }).retracted === true
}

export function withoutRetractedReplies(rows: readonly Message[]): Message[] {
  return rows.some(retractedReply) ? rows.filter(row => !retractedReply(row)) : (rows as Message[])
}
