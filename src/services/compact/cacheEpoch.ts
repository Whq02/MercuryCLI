import { createHash } from 'node:crypto'
import type { AttachmentMessage, Message } from '../../types/message.js'
import type { ApiUsage } from '../../types/wire.js'
import type { Attachment } from '../../utils/attachments/types.js'
import { createAttachmentMessage } from '../attachments/orchestrator.js'
import { conversationRosterKey } from '../providers/toolEconomy.js'
import { carriesRecordedWhole, staticCompositionChanged } from '../../prompt/recordedComposition.js'
import { notBuilt } from '../../pi/holes.js'

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
  deferredNow?: string[]
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

function deferredDefinition(definition: string | undefined): string | undefined {
  if (definition === undefined) return undefined
  try {
    const parsed = JSON.parse(definition) as Record<string, unknown>
    if (parsed === null || typeof parsed !== 'object' || parsed.defer_loading === true) return definition
    return JSON.stringify({ ...parsed, defer_loading: true })
  } catch {
    return definition
  }
}

export function carryFoldPrefix(source: readonly Message[], landing: readonly Message[], owner: string, model: string, usage?: ApiUsage, admitted?: ReadonlySet<string>, defersNow?: (name: string) => boolean): { attachment?: AttachmentMessage; receipt: FoldCacheEpoch } {
  return notBuilt('src/services/compact/cacheEpoch.ts:63')
}
