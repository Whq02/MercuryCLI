import { getSystemPromptSectionCache, setSystemPromptSectionCacheEntry } from '../../../bootstrap/state.js'
import { getSystemContext } from '../../../context.js'
import type { BoundPrefixSection, BoundPrefixToolMark, AttachmentMessage, Message } from '../../../types/message.js'
import type { Attachment } from '../../../utils/attachments/types.js'
import { createAttachmentMessage } from '../../../utils/attachments/orchestrator.js'
import { logForDebugging } from '../../../utils/debug.js'
import { armToolRosterRestore, conversationRosterKey, toolRosterLatchFor, type RosterRestore } from '../toolEconomy.js'
import { getConversationToolSchemas } from '../../../utils/toolSchemaCache.js'

export interface BoundPrefixRecordOptions {
  rosterOnly?: boolean
}

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
  opts?: BoundPrefixRecordOptions,
): Promise<BoundPrefixRecordData | null> {
  const boundKey = conversationRosterKey(rosterOwnerKey, messages, model)
  const latch = toolRosterLatchFor(rosterOwnerKey, messages, model)
  if (latch === undefined) return null
  const definitions = getConversationToolSchemas(boundKey)
  const roster: BoundPrefixToolMark[] = latch.names.map(name => ({ name, deferred: latch.deferred.has(name), ...(definitions.has(name) ? { definition: definitions.get(name)! } : {}) }))
  if (opts?.rosterOnly === true) return { boundKey, rosterEnabled: latch.enabled, roster, sections: [], systemContext: {} }
  const sections: BoundPrefixSection[] = []
  for (const [name, entry] of getSystemPromptSectionCache()) {
    for (const [key, value] of entry.byKey ?? []) {
      if (key !== entry.key) sections.push({ name, key, value })
    }
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
  opts?: BoundPrefixRecordOptions,
): Promise<AttachmentMessage | null> {
  const data = await buildBoundPrefixRecordData(rosterOwnerKey, messages, model, opts)
  if (data === null) return null
  const signature = rosterSignatureOf(data)
  if (emittedKeys.get(data.boundKey) === signature) return null
  emittedKeys.set(data.boundKey, signature)
  const recorded = [...messages].reverse().map(boundPrefixAttachmentOf).find(record => record?.boundKey === data.boundKey) ?? null
  if (recorded !== null && rosterSignatureOf(recorded) === signature) return null
  return createAttachmentMessage({
    type: 'bound_prefix',
    boundKey: data.boundKey,
    rosterEnabled: data.rosterEnabled,
    roster: data.roster,
    sections: recorded !== null && Array.isArray(recorded.sections) ? recorded.sections : data.sections,
    systemContext:
      recorded !== null && recorded.systemContext !== null && typeof recorded.systemContext === 'object' && !Array.isArray(recorded.systemContext)
        ? recorded.systemContext
        : data.systemContext,
  })
}

function rosterSignatureOf(record: Pick<BoundPrefixRecordData, 'boundKey' | 'rosterEnabled' | 'roster'>): string {
  return JSON.stringify({ boundKey: record.boundKey, rosterEnabled: record.rosterEnabled, roster: record.roster })
}

export function restoreBoundPrefixFromMessages(messages: readonly Message[], opts?: BoundPrefixRecordOptions): string | null {
  const records: BoundPrefixAttachment[] = []
  for (const message of messages) {
    const attachment = boundPrefixAttachmentOf(message)
    if (attachment !== null && typeof attachment.boundKey === 'string') records.push(attachment)
  }
  const newest = records[records.length - 1]
  if (newest === undefined) return null
  const boundKey = newest.boundKey
  const record = opts?.rosterOnly === true ? null : ([...records].reverse().find(entry => Array.isArray(entry.sections) && entry.sections.length > 0) ?? newest)

  const sections = record !== null && Array.isArray(record.sections) ? (record.sections as BoundPrefixSection[]) : []
  for (const section of sections) {
    if (typeof section?.name !== 'string') continue
    setSystemPromptSectionCacheEntry(section.name, section.value ?? null, section.key ?? null)
  }

  let marks: RosterRestore['marks'] = []
  for (const entry of records) {
    const roster = Array.isArray(entry.roster) ? (entry.roster as BoundPrefixToolMark[]) : []
    marks = roster
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
    armToolRosterRestore({ key: entry.boundKey, enabled: entry.rosterEnabled === true, marks })
  }

  const systemContext = record?.systemContext
  if (systemContext !== null && systemContext !== undefined && typeof systemContext === 'object' && !Array.isArray(systemContext)) {
    const cache = getSystemContext.cache as { set?: (key: unknown, value: unknown) => unknown } | undefined
    cache?.set?.(MEMO_KEY, Promise.resolve({ ...(systemContext as Record<string, string>) }))
  }

  logForDebugging(
    `prefix record: the first exchange restored (${records.length} record(s), ${marks.length} roster tools in the newest, ${sections.length} sections, ${Object.keys(systemContext ?? {}).length} context keys) for ${boundKey} — the roster, sections and system context re-send as first sent`,
  )
  return boundKey
}
