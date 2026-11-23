import { recordToEntry } from '../fabric/entryCodec.js'
import type { MercuryRecord } from '../fabric/record.js'
import type { Message as MessageType } from '../../engine/message-shapes/message.js'
import { passedOver } from '../../platform/errors/passedOver.js'

export function foldWorkerRecord(rec: unknown, fallbackUuid: string): MessageType | null {
  if (!rec || typeof rec !== 'object') return null
  const env = rec as { schemaVersion?: unknown; payload?: unknown }
  let entry: Record<string, unknown>
  if (typeof env.schemaVersion === 'number' && env.payload && typeof env.payload === 'object') {
    try {
      entry = recordToEntry(rec as MercuryRecord)
    } catch (error) {
      passedOver(error)
      return null
    }
  } else {
    return null
  }
  const r = entry as {
    type?: unknown
    uuid?: unknown
    timestamp?: unknown
    message?: { role?: unknown; content?: unknown }
  }
  if (r.type !== 'user' && r.type !== 'assistant' && r.type !== 'system') return null
  if (r.type !== 'system' && (!r.message || typeof r.message !== 'object')) return null
  const uuid = typeof r.uuid === 'string' && r.uuid.length > 0 ? r.uuid : fallbackUuid
  const out: {
    type: 'user' | 'assistant' | 'system'
    uuid: string
    timestamp?: unknown
    message?: unknown
  } = { ...entry, type: r.type, uuid }
  if (typeof r.timestamp !== 'string') out.timestamp = new Date(0).toISOString()
  if (r.type === 'assistant') {
    const msg = r.message as { content?: unknown }
    if (typeof msg.content === 'string') {
      out.message = { ...(r.message as Record<string, unknown>), content: [{ type: 'text', text: msg.content }] }
    } else if (!Array.isArray(msg.content)) {
      return null
    }
  }
  if (r.type === 'user') {
    const msg = r.message as { content?: unknown }
    if (typeof msg.content !== 'string' && !Array.isArray(msg.content)) return null
  }
  return out as MessageType
}
