import type { Message } from '../../types/message.js'
import type { ToolUseContext } from '../../Tool.js'
import { getSystemPromptSectionCache } from '../../bootstrap/state.js'
import { ownerFromToolUseContext } from '../../services/run/resolveOwner.js'

const LANES_CAP = 64
const RECORD_MARK = /<seq=(\d+)|\[(pending:[^\]\s]+)\]/g
const surfacedByLane = new Map<string, Set<string>>()

export function memoryRecordId(ref: { identity?: string; refId: string }): string {
  if (ref.identity) return ref.identity
  if (ref.refId.startsWith('mneme:')) return `seq:${ref.refId.slice('mneme:'.length)}`
  if (ref.refId.startsWith('mneme-pending:')) return `pending:${ref.refId.slice('mneme-pending:'.length)}`
  return ref.refId
}

function laneKey(context: Pick<ToolUseContext, 'owner' | 'agentId'>): string {
  return String(ownerFromToolUseContext(context))
}

export function surfacedMemoryIds(messages: readonly Message[] | undefined): Set<string> {
  const ids = new Set<string>()
  const scan = (text: string): void => {
    for (const match of text.matchAll(RECORD_MARK)) ids.add(match[1] ? `seq:${match[1]}` : match[2]!)
  }
  for (const message of messages ?? []) {
    if (message.type !== 'attachment') continue
    const attachment = message.attachment
    if (attachment.type === 'relevant_memories') for (const row of attachment.memories) for (const id of row.ids ?? []) ids.add(id)
    if (attachment.type === 'context_capsule') for (const id of attachment.memoryIds ?? []) ids.add(id)
    if (attachment.type === 'bound_prefix') for (const section of attachment.sections) if (section.name === 'memory' || section.name === 'memory_at_start') scan(section.value ?? '')
  }
  const cache = getSystemPromptSectionCache()
  for (const name of ['memory', 'memory_at_start']) {
    const value = cache.get(name)?.value
    if (typeof value === 'string') scan(value)
  }
  return ids
}

export function memorySurfacedThisSession(context: Pick<ToolUseContext, 'owner' | 'agentId'>, messages: readonly Message[] | undefined): Set<string> {
  const ids = surfacedMemoryIds(messages)
  for (const id of surfacedByLane.get(laneKey(context)) ?? []) ids.add(id)
  return ids
}

export function markMemorySurfaced(context: Pick<ToolUseContext, 'owner' | 'agentId'>, ids: Iterable<string>): void {
  const key = laneKey(context)
  let lane = surfacedByLane.get(key)
  if (!lane) {
    if (surfacedByLane.size >= LANES_CAP) {
      const oldest = surfacedByLane.keys().next().value
      if (oldest !== undefined) surfacedByLane.delete(oldest)
    }
    lane = new Set()
    surfacedByLane.set(key, lane)
  }
  for (const id of ids) lane.add(id)
}

export function _resetMemorySurfacedForTesting(): void {
  surfacedByLane.clear()
}
