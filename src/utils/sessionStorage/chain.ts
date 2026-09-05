
import type { UUID } from 'crypto'
import { builtInCommandNames } from '../../commands.js'
import { COMMAND_NAME_TAG } from '../../constants/xml.js'
import { REPL_TOOL_NAME } from '../../tools/REPLTool/constants.js'
import type {
  AttributionSnapshotMessage,
  FileHistorySnapshotMessage,
  SerializedMessage,
  TranscriptMessage,
} from '../../types/logs.js'
import type {
  AssistantMessage,
  AttachmentMessage,
  Message,
  SystemCompactBoundaryMessage,
  SystemMessage,
  UserMessage,
} from '../../types/message.js'
import { logForDebugging } from '../debug.js'
import type { FileHistorySnapshot } from '../fileHistory.js'
import { logError } from '../log.js'
import { extractTag, isCompactBoundaryMessage, normalizeAttachmentForAPI } from '../messages.js'
import { getUserType } from './paths.js'

const SKIP_FIRST_PROMPT_PATTERN =
  /^(?:\s*<[a-z][\w-]*[\s>]|\[Request interrupted by user[^\]]*\])/

export function extractFirstPrompt(transcript: TranscriptMessage[]): string {
  const textContent = getFirstMeaningfulUserMessageTextContent(transcript)
  if (textContent) {
    let result = textContent.replace(/\n/g, ' ').trim()

    if (result.length > 200) {
      result = result.slice(0, 200).trim() + '…'
    }

    return result
  }

  return 'No prompt'
}

export function getFirstMeaningfulUserMessageTextContent<T extends Message>(
  transcript: T[],
): string | undefined {
  for (const msg of transcript) {
    if (msg.type !== 'user' || msg.isMeta) continue
    if ('isCompactSummary' in msg && msg.isCompactSummary) continue

    const content = msg.message?.content
    if (!content) continue

    const texts: string[] = []
    if (typeof content === 'string') {
      texts.push(content)
    } else if (Array.isArray(content)) {
      for (const block of content) {
        if (block.type === 'text' && block.text) {
          texts.push(block.text)
        }
      }
    }

    for (const textContent of texts) {
      if (!textContent) continue

      const commandNameTag = extractTag(textContent, COMMAND_NAME_TAG)
      if (commandNameTag) {
        const commandName = commandNameTag.replace(/^\//, '')

        if (builtInCommandNames().has(commandName)) {
          continue
        } else {
          const commandArgs = extractTag(textContent, 'command-args')?.trim()
          if (!commandArgs) {
            continue
          }
          return `${commandNameTag} ${commandArgs}`
        }
      }

      const bashInput = extractTag(textContent, 'bash-input')
      if (bashInput) {
        return `! ${bashInput}`
      }

      if (SKIP_FIRST_PROMPT_PATTERN.test(textContent)) {
        continue
      }

      return textContent
    }
  }
  return undefined
}

export function removeExtraFields(
  transcript: TranscriptMessage[],
): SerializedMessage[] {
  return transcript.map(m => {
    const { isSidechain, parentUuid, ...serializedMessage } = m
    return serializedMessage
  })
}

export function applyPreservedSegmentRelinks(
  messages: Map<UUID, TranscriptMessage>,
): void {
  type Seg = NonNullable<
    SystemCompactBoundaryMessage['compactMetadata']['preservedSegment']
  >

  let lastSeg: Seg | undefined
  let lastSegBoundaryIdx = -1
  let absoluteLastBoundaryIdx = -1
  const entryIndex = new Map<UUID, number>()
  let i = 0
  for (const entry of messages.values()) {
    entryIndex.set(entry.uuid, i)
    if (isCompactBoundaryMessage(entry)) {
      absoluteLastBoundaryIdx = i
      const seg = entry.compactMetadata?.preservedSegment
      if (seg) {
        lastSeg = seg
        lastSegBoundaryIdx = i
      }
    }
    i++
  }
  if (!lastSeg) return

  const segIsLive = lastSegBoundaryIdx === absoluteLastBoundaryIdx

  const preservedUuids = new Set<UUID>()
  if (segIsLive) {
    const walkSeen = new Set<UUID>()
    let cur = messages.get(lastSeg.tailUuid)
    let reachedHead = false
    while (cur && !walkSeen.has(cur.uuid)) {
      walkSeen.add(cur.uuid)
      preservedUuids.add(cur.uuid)
      if (cur.uuid === lastSeg.headUuid) {
        reachedHead = true
        break
      }
      cur = cur.parentUuid ? messages.get(cur.parentUuid) : undefined
    }
    if (!reachedHead) {
      return
    }
  }

  if (segIsLive) {
    const head = messages.get(lastSeg.headUuid)
    if (head && head.parentUuid !== lastSeg.anchorUuid) {
      messages.set(lastSeg.headUuid, {
        ...head,
        parentUuid: lastSeg.anchorUuid,
      })
    }
    for (const [uuid, msg] of messages) {
      if (msg.parentUuid === lastSeg.anchorUuid && uuid !== lastSeg.headUuid) {
        messages.set(uuid, { ...msg, parentUuid: lastSeg.tailUuid })
      }
    }
    for (const uuid of preservedUuids) {
      const msg = messages.get(uuid)
      if (msg?.type !== 'assistant') continue
      const usage = msg.message.usage
      if (
        usage !== undefined &&
        usage.input_tokens === 0 &&
        usage.output_tokens === 0 &&
        usage.cache_creation_input_tokens === 0 &&
        usage.cache_read_input_tokens === 0
      ) {
        continue
      }
      messages.set(uuid, {
        ...msg,
        message: {
          ...msg.message,
          usage: {
            ...msg.message.usage,
            input_tokens: 0,
            output_tokens: 0,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
          },
        },
      })
    }
  }

  const toDelete: UUID[] = []
  for (const [uuid] of messages) {
    const idx = entryIndex.get(uuid)
    if (
      idx !== undefined &&
      idx < absoluteLastBoundaryIdx &&
      !preservedUuids.has(uuid)
    ) {
      toDelete.push(uuid)
    }
  }
  for (const uuid of toDelete) messages.delete(uuid)
}

export function applySnipRemovals(messages: Map<UUID, TranscriptMessage>): void {
  type WithSnipMeta = { snipMetadata?: { removedUuids?: UUID[] } }
  const toDelete = new Set<UUID>()
  for (const entry of messages.values()) {
    const removedUuids = (entry as WithSnipMeta).snipMetadata?.removedUuids
    if (!removedUuids) continue
    for (const uuid of removedUuids) toDelete.add(uuid)
  }
  if (toDelete.size === 0) return

  const deletedParent = new Map<UUID, UUID | null>()
  let removedCount = 0
  for (const uuid of toDelete) {
    const entry = messages.get(uuid)
    if (!entry) continue
    deletedParent.set(uuid, entry.parentUuid)
    messages.delete(uuid)
    removedCount++
  }

  const resolve = (start: UUID): UUID | null => {
    const path: UUID[] = []
    let cur: UUID | null | undefined = start
    while (cur && toDelete.has(cur)) {
      path.push(cur)
      cur = deletedParent.get(cur)
      if (cur === undefined) {
        cur = null
        break
      }
    }
    for (const p of path) deletedParent.set(p, cur)
    return cur
  }
  let relinkedCount = 0
  for (const [uuid, msg] of messages) {
    if (!msg.parentUuid || !toDelete.has(msg.parentUuid)) continue
    messages.set(uuid, { ...msg, parentUuid: resolve(msg.parentUuid) })
    relinkedCount++
  }

  if (removedCount > 0 || relinkedCount > 0) {
    logForDebugging(
      `snip replay on load: ${removedCount} message(s) removed, ${relinkedCount} survivor(s) re-linked`,
    )
  }
}

export function findLatestMessage<T extends { timestamp: string }>(
  messages: Iterable<T>,
  predicate: (m: T) => boolean,
): T | undefined {
  let latest: T | undefined
  let maxTime = -Infinity
  for (const m of messages) {
    if (!predicate(m)) continue
    const t = Date.parse(m.timestamp)
    if (t > maxTime) {
      maxTime = t
      latest = m
    }
  }
  return latest
}

export function buildConversationChain(
  messages: Map<UUID, TranscriptMessage>,
  leafMessage: TranscriptMessage,
): TranscriptMessage[] {
  const transcript: TranscriptMessage[] = []
  const seen = new Set<UUID>()
  let currentMsg: TranscriptMessage | undefined = leafMessage
  while (currentMsg) {
    if (seen.has(currentMsg.uuid)) {
      logError(
        new Error(
          `Cycle detected in parentUuid chain at message ${currentMsg.uuid}. Returning partial transcript.`,
        ),
      )
      break
    }
    seen.add(currentMsg.uuid)
    transcript.push(currentMsg)
    currentMsg = currentMsg.parentUuid
      ? messages.get(currentMsg.parentUuid)
      : undefined
  }
  transcript.reverse()
  return recoverChainAttachedNotes(messages, recoverOrphanedParallelToolResults(messages, transcript, seen), seen)
}

function recoverChainAttachedNotes(
  messages: Map<UUID, TranscriptMessage>,
  chain: TranscriptMessage[],
  seen: Set<UUID>,
): TranscriptMessage[] {
  const notesByParent = new Map<UUID, TranscriptMessage[]>()
  for (const m of messages.values()) {
    if (m.type !== 'system' || seen.has(m.uuid) || !m.parentUuid || !seen.has(m.parentUuid)) continue
    const subtype = (m as { subtype?: string }).subtype
    if (subtype === 'compact_boundary' || subtype === 'microcompact_boundary') continue
    const group = notesByParent.get(m.parentUuid)
    if (group) group.push(m)
    else notesByParent.set(m.parentUuid, [m])
  }
  if (notesByParent.size === 0) return chain
  const out: TranscriptMessage[] = []
  for (const m of chain) {
    out.push(m)
    const notes = notesByParent.get(m.uuid)
    if (notes) {
      for (const note of notes) {
        seen.add(note.uuid)
        out.push(note)
      }
    }
  }
  return out
}

function recoverOrphanedParallelToolResults(
  messages: Map<UUID, TranscriptMessage>,
  chain: TranscriptMessage[],
  seen: Set<UUID>,
): TranscriptMessage[] {
  type ChainAssistant = Extract<TranscriptMessage, { type: 'assistant' }>
  const chainAssistants = chain.filter(
    (m): m is ChainAssistant => m.type === 'assistant',
  )
  if (chainAssistants.length === 0) return chain

  const anchorByMsgId = new Map<string, ChainAssistant>()
  for (const a of chainAssistants) {
    if (a.message.id) anchorByMsgId.set(a.message.id, a)
  }

  const siblingsByMsgId = new Map<string, TranscriptMessage[]>()
  const toolResultsByAsst = new Map<UUID, TranscriptMessage[]>()
  for (const m of messages.values()) {
    if (m.type === 'assistant' && m.message.id) {
      const group = siblingsByMsgId.get(m.message.id)
      if (group) group.push(m)
      else siblingsByMsgId.set(m.message.id, [m])
    } else if (
      m.type === 'user' &&
      m.parentUuid &&
      Array.isArray(m.message.content) &&
      m.message.content.some(b => b.type === 'tool_result')
    ) {
      const group = toolResultsByAsst.get(m.parentUuid)
      if (group) group.push(m)
      else toolResultsByAsst.set(m.parentUuid, [m])
    }
  }

  const processedGroups = new Set<string>()
  const inserts = new Map<UUID, TranscriptMessage[]>()
  let recoveredCount = 0
  for (const asst of chainAssistants) {
    const msgId = asst.message.id
    if (!msgId || processedGroups.has(msgId)) continue
    processedGroups.add(msgId)

    const group = siblingsByMsgId.get(msgId) ?? [asst]
    const orphanedSiblings = group.filter(s => !seen.has(s.uuid))
    const orphanedTRs: TranscriptMessage[] = []
    for (const member of group) {
      const trs = toolResultsByAsst.get(member.uuid)
      if (!trs) continue
      for (const tr of trs) {
        if (!seen.has(tr.uuid)) orphanedTRs.push(tr)
      }
    }
    if (orphanedSiblings.length === 0 && orphanedTRs.length === 0) continue

    orphanedSiblings.sort((a, b) => a.timestamp.localeCompare(b.timestamp))
    orphanedTRs.sort((a, b) => a.timestamp.localeCompare(b.timestamp))

    const anchor = anchorByMsgId.get(msgId)!
    const recovered = [...orphanedSiblings, ...orphanedTRs]
    for (const r of recovered) seen.add(r.uuid)
    recoveredCount += recovered.length
    inserts.set(anchor.uuid, recovered)
  }

  if (recoveredCount === 0) return chain

  const result: TranscriptMessage[] = []
  for (const m of chain) {
    result.push(m)
    const toInsert = inserts.get(m.uuid)
    if (toInsert) result.push(...toInsert)
  }
  return result
}

export function checkResumeConsistency(chain: Message[]): void {
  for (let i = chain.length - 1; i >= 0; i--) {
    const m = chain[i]!
    if (m.type !== 'system' || m.subtype !== 'turn_duration') continue
    const expected = m.messageCount
    if (expected === undefined) return
    const drift = i - expected
    if (drift !== 0) {
      logForDebugging(
        `resume round-trip drift: turn_duration checkpoint expected ${expected} prior message(s), chain has ${i} (drift ${drift > 0 ? '+' : ''}${drift})`,
        { level: 'warn' },
      )
    }
    return
  }
}

export function buildFileHistorySnapshotChain(
  fileHistorySnapshots: Map<UUID, FileHistorySnapshotMessage>,
  conversation: TranscriptMessage[],
): FileHistorySnapshot[] {
  const snapshots: FileHistorySnapshot[] = []
  const indexByMessageId = new Map<string, number>()
  for (const message of conversation) {
    const snapshotMessage = fileHistorySnapshots.get(message.uuid)
    if (!snapshotMessage) {
      continue
    }
    const { snapshot, isSnapshotUpdate } = snapshotMessage
    const existingIndex = isSnapshotUpdate
      ? indexByMessageId.get(snapshot.messageId)
      : undefined
    if (existingIndex === undefined) {
      indexByMessageId.set(snapshot.messageId, snapshots.length)
      snapshots.push(snapshot)
    } else {
      snapshots[existingIndex] = snapshot
    }
  }
  return snapshots
}

export function buildAttributionSnapshotChain(
  attributionSnapshots: Map<UUID, AttributionSnapshotMessage>,
  _conversation: TranscriptMessage[],
): AttributionSnapshotMessage[] {
  return Array.from(attributionSnapshots.values())
}

export function cleanMessagesForLogging(
  messages: Message[],
  allMessages: readonly Message[] = messages,
  replIds?: Set<string>,
): Transcript {
  const filtered = messages.filter(isLoggableMessage) as Transcript
  return getUserType() !== 'ant'
    ? transformMessagesForExternalTranscript(
        filtered,
        replIds ?? collectReplIds(allMessages),
      )
    : filtered
}

export type Transcript = (
  | UserMessage
  | AssistantMessage
  | AttachmentMessage
  | SystemMessage
)[]

export function isLoggableMessage(m: Message): boolean {
  if (m.type === 'progress') return false
  if (m.type === 'attachment' && getUserType() !== 'ant') {
    const att = m.attachment
    if (att.type === 'hook_non_blocking_error' || att.type === 'hook_error_during_execution') return true
    if (att.type === 'bypassed_ask') return true
    if (att.type === 'bound_prefix') return true
    if (att.type === 'dead_thinking') return true
    return normalizeAttachmentForAPI(att).length > 0
  }
  return true
}

export function collectReplIds(messages: readonly Message[]): Set<string> {
  const ids = new Set<string>()
  collectReplIdsInto(ids, messages)
  return ids
}

export function collectReplIdsInto(
  ids: Set<string>,
  messages: readonly Message[],
): void {
  for (const m of messages) {
    if (m.type === 'assistant' && Array.isArray(m.message.content)) {
      for (const b of m.message.content) {
        if (b.type === 'tool_use' && b.name === REPL_TOOL_NAME) {
          ids.add(b.id)
        }
      }
    }
  }
}

export function transformMessagesForExternalTranscript(
  messages: Transcript,
  replIds: Set<string>,
): Transcript {
  return messages.flatMap((m): Transcript[number] | Transcript => {
    if (m.type === 'assistant' && Array.isArray(m.message.content)) {
      const content = m.message.content
      const hasRepl = content.some(
        b => b.type === 'tool_use' && b.name === REPL_TOOL_NAME,
      )
      const filtered = hasRepl
        ? content.filter(
            b => !(b.type === 'tool_use' && b.name === REPL_TOOL_NAME),
          )
        : content
      if (filtered.length === 0) return []
      if (m.isVirtual) {
        const { isVirtual: _omit, ...rest } = m
        return [{ ...rest, message: { ...m.message, content: filtered } }]
      }
      if (filtered !== content) {
        return [{ ...m, message: { ...m.message, content: filtered } }]
      }
      return [m]
    }
    if (m.type === 'user' && Array.isArray(m.message.content)) {
      const content = m.message.content
      const hasRepl = content.some(
        b => b.type === 'tool_result' && replIds.has(b.tool_use_id),
      )
      const filtered = hasRepl
        ? content.filter(
            b => !(b.type === 'tool_result' && replIds.has(b.tool_use_id)),
          )
        : content
      if (filtered.length === 0) return []
      if (m.isVirtual) {
        const { isVirtual: _omit, ...rest } = m
        return [{ ...rest, message: { ...m.message, content: filtered } }]
      }
      if (filtered !== content) {
        return [{ ...m, message: { ...m.message, content: filtered } }]
      }
      return [m]
    }
    if ('isVirtual' in m && m.isVirtual) {
      const { isVirtual: _omit, ...rest } = m
      return [rest]
    }
    return [m]
  }) as Transcript
}
