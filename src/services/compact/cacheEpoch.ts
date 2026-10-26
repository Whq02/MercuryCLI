import { createHash } from 'node:crypto'
import type { AttachmentMessage, Message } from '../../types/message.js'
import type { ApiUsage } from '../../types/wire.js'
import type { Attachment } from '../../utils/attachments/types.js'
import { createAttachmentMessage } from '../../utils/attachments/orchestrator.js'
import { conversationRosterKey } from '../providers/toolEconomy.js'
import { carriesRecordedWhole, staticCompositionChanged } from '../../prompt/recordedComposition.js'

export type FoldCacheUsage = { input: number; output: number; read: number; write: number; write5m: number | null; write1h: number | null }
export type FoldCacheEpoch = {
  version: 1
  state: 'preserved' | 'moved' | 'unavailable'
  beforeKey: string | null
  afterKey: string
  beforeHash: string | null
  afterHash: string | null
  messagePrefixPreserved: false
  summary: FoldCacheUsage | null
  loadedInFull?: string[]
}

type BoundRecord = Extract<Attachment, { type: 'bound_prefix' }>

export function foldCacheUsage(usage: ApiUsage | undefined): FoldCacheUsage | null {
  if (!usage) return null
  const create = usage.cache_creation as { ephemeral_5m_input_tokens?: number; ephemeral_1h_input_tokens?: number } | undefined
  return {
    input: (usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0),
    output: usage.output_tokens ?? 0, read: usage.cache_read_input_tokens ?? 0, write: usage.cache_creation_input_tokens ?? 0,
    write5m: create?.ephemeral_5m_input_tokens ?? null, write1h: create?.ephemeral_1h_input_tokens ?? null,
  }
}

function stableFoldPrefixHash(record: BoundRecord): string {
  return createHash('sha256').update(JSON.stringify({ rosterEnabled: record.rosterEnabled, roster: record.roster, sections: record.sections })).digest('hex')
}

function loadedInFull(definition: string | undefined): string | undefined {
  if (definition === undefined) return undefined
  try {
    const parsed = JSON.parse(definition) as Record<string, unknown>
    if (parsed === null || typeof parsed !== 'object' || !('defer_loading' in parsed)) return definition
    const { defer_loading, ...rest } = parsed
    void defer_loading
    return JSON.stringify(rest)
  } catch {
    return definition
  }
}

export function carryFoldPrefix(source: readonly Message[], landing: readonly Message[], owner: string, model: string, usage?: ApiUsage, admitted: ReadonlySet<string> = new Set()): { attachment?: AttachmentMessage; receipt: FoldCacheEpoch } {
  const beforeKey = conversationRosterKey(owner, source, model)
  const afterKey = conversationRosterKey(owner, landing, model)
  const previous = [...source].reverse().find(row => row.type === 'attachment' && row.attachment.type === 'bound_prefix' && row.attachment.boundKey === beforeKey)
  if (previous?.type !== 'attachment' || previous.attachment.type !== 'bound_prefix' || !Array.isArray(previous.attachment.sections) || staticCompositionChanged(previous.attachment.sections) || carriesRecordedWhole(previous.attachment.sections)) {
    return { receipt: { version: 1, state: 'unavailable', beforeKey: null, afterKey, beforeHash: null, afterHash: null, messagePrefixPreserved: false, summary: foldCacheUsage(usage) } }
  }
  const before = previous.attachment
  const flipped: string[] = []
  const roster = before.roster.map(mark => {
    if (!mark.deferred || !admitted.has(mark.name)) return mark
    flipped.push(mark.name)
    const definition = loadedInFull(mark.definition)
    return { ...mark, deferred: false, ...(definition !== undefined ? { definition } : {}) }
  })
  const after: BoundRecord = { ...before, boundKey: afterKey, roster }
  const beforeHash = stableFoldPrefixHash(before)
  const afterHash = stableFoldPrefixHash(after)
  if (flipped.length === 0 && beforeHash !== afterHash) throw new Error('The stable fold prefix changed; the original context is kept.')
  return {
    attachment: createAttachmentMessage(after),
    receipt: {
      version: 1,
      state: flipped.length === 0 ? 'preserved' : 'moved',
      beforeKey,
      afterKey,
      beforeHash,
      afterHash,
      messagePrefixPreserved: false,
      summary: foldCacheUsage(usage),
      ...(flipped.length > 0 ? { loadedInFull: flipped } : {}),
    },
  }
}
