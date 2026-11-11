import type { Message } from '../../types/message.js'
import { settleToolUsesOfEndedRun } from '../../utils/messages/apiFilters.js'
import { deriveUUID } from '../../utils/messages/identity.js'
import type { SessionFactsV1 } from './seatProjections.js'

const PAINTED_RESULT_INDEX = 0x7e000
const paintedResults = new WeakMap<Message, Map<string, Message>>()

type Block = { type: string; id?: string; tool_use_id?: string }
const blocksOf = (row: Message): Block[] =>
  (row.type === 'user' || row.type === 'assistant') && Array.isArray(row.message.content) ? (row.message.content as unknown as Block[]) : []

function asksAReply(row: Message): boolean {
  return row.type === 'user' && !blocksOf(row).some(block => block.type === 'tool_result')
}

export function endedRunResults(
  records: readonly Message[],
  facts: Pick<SessionFactsV1, 'busy' | 'atMs' | 'turnStartedAt'> | null,
  carrierGone: boolean,
): Message[] {
  const endedBefore = carrierGone ? Number.POSITIVE_INFINITY : facts === null ? null : facts.busy ? (facts.turnStartedAt ?? null) : facts.atMs
  if (endedBefore === null) return []
  let start = records.length
  while (start > 0 && !asksAReply(records[start - 1]!)) start--
  const tail = records.slice(start)
  if (!tail.some(row => row.type === 'assistant')) return []
  const known = new Set<Message>(tail)
  const results = settleToolUsesOfEndedRun(tail).filter(row => !known.has(row))
  const painted: Message[] = []
  for (const result of results) {
    const reply = tail.find(row => row.uuid === (result as { sourceToolAssistantUUID?: string }).sourceToolAssistantUUID)
    const call = blocksOf(result)[0]?.tool_use_id
    if (reply === undefined || call === undefined || !(Date.parse(reply.timestamp) < endedBefore)) return []
    const kept = paintedResults.get(reply) ?? new Map<string, Message>()
    paintedResults.set(reply, kept)
    const at = blocksOf(reply).findIndex(block => block.type === 'tool_use' && block.id === call)
    const row = kept.get(call) ?? ({ ...result, uuid: deriveUUID(reply.uuid, PAINTED_RESULT_INDEX + at), timestamp: reply.timestamp } as Message)
    kept.set(call, row)
    painted.push(row)
  }
  return painted
}
