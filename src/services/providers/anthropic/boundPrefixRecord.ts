import { getSystemPromptSectionCache, setSystemPromptSectionCacheEntry } from '../../../bootstrap/state.js'
import type { BoundPrefixSection, BoundPrefixToolMark, AttachmentMessage, Message } from '../../../types/message.js'
import type { Attachment } from '../../../utils/attachments/types.js'
import { createAttachmentMessage } from '../../../utils/attachments/orchestrator.js'
import { logForDebugging } from '../../../utils/debug.js'
import { armToolRosterRestore, conversationRosterKey, toolRosterLatchFor } from '../toolEconomy.js'

export interface BoundPrefixRecordData {
  boundKey: string
  rosterEnabled: boolean
  roster: BoundPrefixToolMark[]
  sections: BoundPrefixSection[]
}

type BoundPrefixAttachment = Extract<Attachment, { type: 'bound_prefix' }>

const boundPrefixAttachmentOf = (message: Message): BoundPrefixAttachment | null =>
  message.type === 'attachment' && message.attachment.type === 'bound_prefix'
    ? (message.attachment as BoundPrefixAttachment)
    : null

export function boundPrefixRecordExists(messages: readonly Message[], boundKey: string): boolean {
  return messages.some(m => boundPrefixAttachmentOf(m)?.boundKey === boundKey)
}

export function buildBoundPrefixRecordData(
  rosterOwnerKey: string,
  messages: readonly Message[],
  model: string,
): BoundPrefixRecordData | null {
  const boundKey = conversationRosterKey(rosterOwnerKey, messages, model)
  const latch = toolRosterLatchFor(rosterOwnerKey, messages, model)
  if (latch === undefined) return null
  const roster: BoundPrefixToolMark[] = latch.names.map(name => ({ name, deferred: latch.deferred.has(name) }))
  const sections: BoundPrefixSection[] = []
  for (const [name, entry] of getSystemPromptSectionCache()) {
    sections.push({ name, key: entry.key, value: entry.value })
  }
  return { boundKey, rosterEnabled: latch.enabled, roster, sections }
}

const emittedKeys = new Set<string>()

export function resetBoundPrefixEmitted(): void {
  emittedKeys.clear()
}

export function boundPrefixRecordToEmit(
  rosterOwnerKey: string,
  messages: readonly Message[],
  model: string,
): AttachmentMessage | null {
  const data = buildBoundPrefixRecordData(rosterOwnerKey, messages, model)
  if (data === null) return null
  if (emittedKeys.has(data.boundKey)) return null
  emittedKeys.add(data.boundKey)
  if (boundPrefixRecordExists(messages, data.boundKey)) return null
  return createAttachmentMessage({
    type: 'bound_prefix',
    boundKey: data.boundKey,
    rosterEnabled: data.rosterEnabled,
    roster: data.roster,
    sections: data.sections,
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
    .map(mark => ({ name: mark.name, deferred: mark.deferred === true }))
  armToolRosterRestore({ key: boundKey, enabled: record.rosterEnabled === true, marks })

  logForDebugging(
    `prefix record: the first exchange restored (${marks.length} roster tools, ${sections.length} sections) for ${boundKey} — the roster and sections re-send as first sent`,
  )
  return boundKey
}
