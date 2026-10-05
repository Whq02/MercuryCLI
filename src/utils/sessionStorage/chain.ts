import type { UUID } from 'crypto'
import { builtInCommandNames } from '../../commands.js'
import { COMMAND_NAME_TAG } from '../../constants/xml.js'
import { projectForTranscript } from '../../services/desktop/screenshotRetention.js'
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
  SystemMessage,
  UserMessage,
} from '../../types/message.js'
import { logForDebugging } from '../debug.js'
import type { FileHistorySnapshot } from '../fileHistory.js'
import { extractTag, normalizeAttachmentForAPI } from '../messages.js'
import { transcriptRows } from './rowGraph.js'

const SKIP_FIRST_PROMPT_PATTERN =
  /^(?:\s*<[a-z][\w-]*[\s>]|\[Request interrupted by user[^\]]*\])/

export function extractFirstPrompt(transcript: TranscriptMessage[]): string {
  const textContent = getFirstMeaningfulUserMessageTextContent(transcript)
  if (!textContent) return 'No prompt'
  const flat = textContent.replace(/\n/g, ' ').trim()
  return flat.length > 200 ? flat.slice(0, 200).trim() + '…' : flat
}

export function getFirstMeaningfulUserMessageTextContent<T extends Message>(
  transcript: T[],
): string | undefined {
  for (const msg of transcript) {
    if (msg.type !== 'user' || msg.isMeta || msg.isCompactSummary) continue
    const content = msg.message?.content
    if (!content) continue
    const texts = typeof content === 'string'
      ? [content]
      : Array.isArray(content) ? content.flatMap(block => block.type === 'text' && block.text ? [block.text] : []) : []
    for (const text of texts) {
      if (!text) continue
      const command = extractTag(text, COMMAND_NAME_TAG)
      if (command) {
        if (builtInCommandNames().has(command.replace(/^\//, ''))) continue
        const args = extractTag(text, 'command-args')?.trim()
        if (!args) continue
        return `${command} ${args}`
      }
      const shell = extractTag(text, 'bash-input')
      if (shell) return `! ${shell}`
      if (!SKIP_FIRST_PROMPT_PATTERN.test(text)) return text
    }
  }
  return undefined
}

export function removeExtraFields(
  transcript: TranscriptMessage[],
): SerializedMessage[] {
  return transcript.map(({ isSidechain, parentUuid, ...message }) => message)
}

export function applyPreservedSegmentRelinks(
  messages: Map<UUID, TranscriptMessage>,
): void {
  transcriptRows(messages).relinkPreserved()
}

export function applySnipRemovals(messages: Map<UUID, TranscriptMessage>): void {
  transcriptRows(messages).removeSnipped()
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
    if (t >= maxTime) {
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
  return transcriptRows(messages).chain(leafMessage)
}

export function checkResumeConsistency(chain: Message[]): void {
  for (let i = chain.length - 1; i >= 0; i--) {
    const row = chain[i]!
    if (row.type !== 'system' || row.subtype !== 'turn_duration') continue
    if (row.messageCount === undefined) return
    const drift = i - row.messageCount
    if (drift !== 0) {
      logForDebugging(
        `resume round-trip drift: turn_duration checkpoint expected ${row.messageCount} prior message(s), chain has ${i} (drift ${drift > 0 ? '+' : ''}${drift})`,
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
  const slots = new Map<string, number>()
  for (const row of conversation) {
    const entry = fileHistorySnapshots.get(row.uuid)
    if (!entry) continue
    const slot = entry.isSnapshotUpdate ? slots.get(entry.snapshot.messageId) : undefined
    if (slot !== undefined) snapshots[slot] = entry.snapshot
    else {
      slots.set(entry.snapshot.messageId, snapshots.length)
      snapshots.push(entry.snapshot)
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
): Transcript {
  return transformMessagesForExternalTranscript(messages.filter(isLoggableMessage) as Transcript)
    .map(message => projectForTranscript(message, allMessages))
}

export type Transcript = (
  | UserMessage
  | AssistantMessage
  | AttachmentMessage
  | SystemMessage
)[]

export function isLoggableMessage(m: Message): boolean {
  if (m.type === 'progress') return false
  if (m.type !== 'attachment') return true
  const att = m.attachment
  switch (att.type) {
    case 'hook_non_blocking_error':
    case 'hook_error_during_execution':
    case 'bypassed_ask':
    case 'bound_prefix':
    case 'dead_thinking':
    case 'images_left_out':
      return true
    default:
      return Boolean((att as { capsuleReceipt?: unknown }).capsuleReceipt) || normalizeAttachmentForAPI(att).length > 0
  }
}

export function transformMessagesForExternalTranscript(messages: Transcript): Transcript {
  return messages.flatMap((m): Transcript[number] | Transcript => {
    if ((m.type === 'assistant' || m.type === 'user') && Array.isArray(m.message.content) && m.message.content.length === 0) return []
    if ('isVirtual' in m && m.isVirtual) {
      const { isVirtual: _omit, ...rest } = m
      return [rest]
    }
    return [m]
  }) as Transcript
}
