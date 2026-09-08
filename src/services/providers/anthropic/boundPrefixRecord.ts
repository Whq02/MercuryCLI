import { getSystemPromptSectionCache, setSystemPromptSectionCacheEntry } from '../../../bootstrap/state.js'
import { getSystemContext } from '../../../context.js'
import type { BoundPrefixSection, BoundPrefixToolMark, AttachmentMessage, Message } from '../../../types/message.js'
import type { Attachment } from '../../../utils/attachments/types.js'
import { createAttachmentMessage } from '../../../utils/attachments/orchestrator.js'
import { logForDebugging } from '../../../utils/debug.js'
import { armToolRosterRestore, conversationRosterKey, toolRosterLatchFor } from '../toolEconomy.js'
import { getConversationToolSchemas } from '../../../utils/toolSchemaCache.js'

export interface BoundPrefixRecordData {
  boundKey: string
  rosterEnabled: boolean
  roster: BoundPrefixToolMark[]
  sections: BoundPrefixSection[]
  systemContext: Record<string, string>
}

const MEMO_KEY = undefined

async function sentSystemContext(): Promise<Record<string, string>> {
  const cache = getSystemContext.cache as { has?: (key: unknown) => boolean } | undefined
  if (cache?.has?.(MEMO_KEY) !== true) return {}
  return { ...(await getSystemContext()) }
}

type BoundPrefixAttachment = Extract<Attachment, { type: 'bound_prefix' }>

const boundPrefixAttachmentOf = (message: Message): BoundPrefixAttachment | null =>
  message.type === 'attachment' && message.attachment.type === 'bound_prefix'
    ? (message.attachment as BoundPrefixAttachment)
    : null

export function boundPrefixRecordExists(messages: readonly Message[], boundKey: string): boolean {
  return messages.some(m => boundPrefixAttachmentOf(m)?.boundKey === boundKey)
}

export async function buildBoundPrefixRecordData(
  rosterOwnerKey: string,
  messages: readonly Message[],
  model: string,
): Promise<BoundPrefixRecordData | null> {
  const boundKey = conversationRosterKey(rosterOwnerKey, messages, model)
  const latch = toolRosterLatchFor(rosterOwnerKey, messages, model)
  if (latch === undefined) return null
  const definitions = getConversationToolSchemas(boundKey)
  const roster: BoundPrefixToolMark[] = latch.names.map(name => ({ name, deferred: latch.deferred.has(name), ...(definitions.has(name) ? { definition: definitions.get(name)! } : {}) }))
  const sections: BoundPrefixSection[] = []
  for (const [name, entry] of getSystemPromptSectionCache()) {
    sections.push({ name, key: entry.key, value: entry.value })
  }
  const systemContext = await sentSystemContext()
  return { boundKey, rosterEnabled: latch.enabled, roster, sections, systemContext }
}

const emittedKeys = new Map<string, string>()

export function resetBoundPrefixEmitted(): void {
  emittedKeys.clear()
}

export async function boundPrefixRecordToEmit(
  rosterOwnerKey: string,
  messages: readonly Message[],
  model: string,
): Promise<AttachmentMessage | null> {
  const data = await buildBoundPrefixRecordData(rosterOwnerKey, messages, model)
  if (data === null) return null
  const signature = JSON.stringify(data)
  if (emittedKeys.get(data.boundKey) === signature) return null
  emittedKeys.set(data.boundKey, signature)
  const recorded = [...messages].reverse().map(boundPrefixAttachmentOf).find(record => record?.boundKey === data.boundKey)
  if (recorded != null && JSON.stringify({ boundKey: recorded.boundKey, rosterEnabled: recorded.rosterEnabled, roster: recorded.roster, sections: recorded.sections, systemContext: recorded.systemContext }) === signature) return null
  return createAttachmentMessage({
    type: 'bound_prefix',
    boundKey: data.boundKey,
    rosterEnabled: data.rosterEnabled,
    roster: data.roster,
    sections: data.sections,
    systemContext: data.systemContext,
  })
}

export function restoreBoundPrefixFromMessages(messages: readonly Message[]): string | null {
  let record: BoundPrefixAttachment | null = null
  for (const message of messages) {
    const attachment = boundPrefixAttachmentOf(message)
    if (attachment !== null) record = attachment
  }
  if (record === null || typeof record.boundKey !== 'string') return null
  const boundKey = record.boundKey

  const sections = Array.isArray(record.sections) ? (record.sections as BoundPrefixSection[]) : []
  for (const section of sections) {
    if (typeof section?.name !== 'string') continue
    setSystemPromptSectionCacheEntry(section.name, section.value ?? null, section.key ?? null)
  }

  const roster = Array.isArray(record.roster) ? (record.roster as BoundPrefixToolMark[]) : []
  const marks = roster
    .filter(mark => typeof mark?.name === 'string')
    .map(mark => {
      if (typeof mark.definition === 'string') {
        try {
          const definition = JSON.parse(mark.definition) as { name?: unknown; input_schema?: unknown } | null
          if (definition !== null && definition.name === mark.name && typeof definition.input_schema === 'object' && definition.input_schema !== null) {
            return { name: mark.name, deferred: mark.deferred === true, definition: mark.definition }
          }
        } catch {}
      }
      return { name: mark.name, deferred: mark.deferred === true }
    })
  armToolRosterRestore({ key: boundKey, enabled: record.rosterEnabled === true, marks })

  const systemContext = record.systemContext
  if (systemContext !== null && typeof systemContext === 'object' && !Array.isArray(systemContext)) {
    const cache = getSystemContext.cache as { set?: (key: unknown, value: unknown) => unknown } | undefined
    cache?.set?.(MEMO_KEY, Promise.resolve({ ...(systemContext as Record<string, string>) }))
  }

  logForDebugging(
    `prefix record: the first exchange restored (${marks.length} roster tools, ${sections.length} sections, ${Object.keys(systemContext ?? {}).length} context keys) for ${boundKey} — the roster, sections and system context re-send as first sent`,
  )
  return boundKey
}
