import type { UUID } from 'crypto'
import { BASH_INPUT_TAG, COMMAND_ARGS_TAG, COMMAND_NAME_TAG } from '../../engine/message-shapes/messageTags.js'
import type {
  AttributionSnapshotEntry,
  FileHistorySnapshotEntry,
  SerializedMessage,
  TranscriptMessage,
} from './transcriptEntries.js'
import type {
  AssistantMessage,
  AttachmentMessage,
  Message,
  SystemMessage,
  UserMessage,
} from '../../engine/message-shapes/message.js'
import { logForDebugging } from '../../platform/logs/debugLog.js'
import type { FileHistorySnapshot } from './fileHistory.js'
import { extractTag } from '../../engine/message-shapes/text.js'
import { stripTerminalControls } from '../../platform/text/strings.js'
import { transcriptRows } from './rowGraph.js'
import { electConversationEnd } from './conversationEnd.js'
import { isBuiltInCommandName } from './builtInCommands.js'
import { transcriptProjector } from './transcriptProjector.js'
const OPEN_LOWERCASE_TAG_RE = /^\s*<[a-z][\w-]*[\s>]/
const INTERRUPTED_RE = /^\[Request (?:interrupted by user|cut off)[^\]]*\]/

const PERSISTED_ATTACHMENT_TYPES: ReadonlySet<string> = new Set([
  'bypassed_ask',
  'bound_prefix',
  'dead_thinking',
  'dropped_thinking',
  'images_left_out',
])

function meaningfulTextFrom(text: string): string | undefined {
  if (text === '') return undefined
  const commandName = extractTag(text, COMMAND_NAME_TAG)
  if (commandName !== null) {
    const lookup = commandName.startsWith('/') ? commandName.slice(1) : commandName
    if (isBuiltInCommandName(lookup)) return undefined
    const commandArgs = extractTag(text, COMMAND_ARGS_TAG)?.trim()
    if (!commandArgs) return undefined
    return `${commandName} ${commandArgs}`
  }
  const bashInput = extractTag(text, BASH_INPUT_TAG)
  if (bashInput !== null) return `! ${bashInput}`
  if (OPEN_LOWERCASE_TAG_RE.test(text) || INTERRUPTED_RE.test(text)) return undefined
  return text
}

export function extractFirstPrompt(transcript: TranscriptMessage[]): string {
  const text = getFirstMeaningfulUserMessageTextContent(transcript)
  if (text === undefined) return 'No prompt'
  const cleaned = stripTerminalControls(text).replace(/\n/g, ' ').trim()
  if (cleaned.length > 200) return `${cleaned.slice(0, 200).trim()}…`
  return cleaned
}

export function getFirstMeaningfulUserMessageTextContent<T extends Message>(
  transcript: T[],
): string | undefined {
  for (const entry of transcript) {
    if (entry.type !== 'user') continue
    if (entry.isMeta || entry.isCompactSummary) continue
    const content = entry.message.content
    if (typeof content === 'string') {
      const found = meaningfulTextFrom(content)
      if (found !== undefined) return found
      continue
    }
    if (Array.isArray(content)) {
      for (const block of content) {
        if (block.type !== 'text') continue
        const found = meaningfulTextFrom(block.text)
        if (found !== undefined) return found
      }
    }
  }
  return undefined
}

export function removeExtraFields(
  transcript: TranscriptMessage[],
): SerializedMessage[] {
  return transcript.map(({ isSidechain, parentUuid, ...row }) => row)
}

export function applyPreservedSegmentRelinks(
  messages: Map<UUID, TranscriptMessage>,
): void {
  transcriptRows(messages).relinkPreserved()
}

export function applySnipRemovals(messages: Map<UUID, TranscriptMessage>): void {
  transcriptRows(messages).removeSnipped()
}

function* accepted<T>(rows: Iterable<T>, accepts: (row: T) => boolean): Generator<T> {
  for (const row of rows) if (accepts(row)) yield row
}

const stampOf = (row: { timestamp: string }): number => Date.parse(row.timestamp)

export function findLatestMessage<T extends { timestamp: string }>(
  messages: Iterable<T>,
  predicate: (m: T) => boolean,
): T | undefined {
  let best: T | undefined
  let bestStamp = -Infinity
  for (const row of accepted(messages, predicate)) {
    const stamp = stampOf(row)
    if (Number.isNaN(stamp)) continue
    if (stamp >= bestStamp) {
      best = row
      bestStamp = stamp
    }
  }
  return best
}

export function buildConversationChain(
  messages: Map<UUID, TranscriptMessage>,
  leafMessage: TranscriptMessage,
): TranscriptMessage[] {
  return transcriptRows(messages).chain(leafMessage)
}

export function buildScreenConversation(
  messages: Map<UUID, TranscriptMessage>,
): TranscriptMessage[] {
  return electConversationEnd(messages)?.screenRows ?? []
}

export function checkResumeConsistency(chain: Message[]): void {
  let checkpointIndex = -1
  for (let i = chain.length - 1; i >= 0; i--) {
    const entry = chain[i]!
    if (entry.type === 'system' && entry.subtype === 'turn_duration') {
      checkpointIndex = i
      break
    }
  }
  if (checkpointIndex === -1) return
  const checkpoint = chain[checkpointIndex]!
  if (checkpoint.type !== 'system' || checkpoint.subtype !== 'turn_duration') return
  const expected = checkpoint.messageCount
  if (expected === undefined) return
  const drift = checkpointIndex - expected
  if (drift === 0) return
  const signed = drift > 0 ? `+${drift}` : `${drift}`
  logForDebugging(
    `resume round-trip drift: turn_duration checkpoint expected ${expected} prior message(s), chain has ${checkpointIndex} (drift ${signed})`,
    { level: 'warn' },
  )
}

export function buildFileHistorySnapshotChain(
  fileHistorySnapshots: Map<UUID, FileHistorySnapshotEntry>,
  conversation: TranscriptMessage[],
): FileHistorySnapshot[] {
  const snapshots: FileHistorySnapshot[] = []
  const indexByMessageId = new Map<UUID, number>()
  for (const row of conversation) {
    const entry = fileHistorySnapshots.get(row.uuid)
    if (!entry) continue
    const snapshot = entry.snapshot
    if (entry.isSnapshotUpdate) {
      const existingIndex = indexByMessageId.get(snapshot.messageId)
      if (existingIndex !== undefined) {
        snapshots[existingIndex] = snapshot
        continue
      }
    }
    indexByMessageId.set(snapshot.messageId, snapshots.length)
    snapshots.push(snapshot)
  }
  return snapshots
}

export function buildAttributionSnapshotChain(
  attributionSnapshots: Map<UUID, AttributionSnapshotEntry>,
  _conversation: TranscriptMessage[],
): AttributionSnapshotEntry[] {
  return Array.from(attributionSnapshots.values())
}

export function cleanForTranscript(
  messages: Message[],
  allMessages?: readonly Message[],
): Transcript {
  const transcribable = messages.filter(
    (m): m is Transcript[number] => isTranscribable(m) && m.type !== 'progress',
  )
  const external = transformMessagesForExternalTranscript(transcribable)
  const context = allMessages ?? messages
  return external.map(m => transcriptProjector().projectForTranscript(m, context))
}

export type Transcript = (UserMessage | AssistantMessage | AttachmentMessage | SystemMessage)[]

export function writtenChainTail(messages: Message[], parentUuid?: UUID | null): UUID | undefined {
  return cleanForTranscript(messages).at(-1)?.uuid ?? parentUuid ?? undefined
}

export function isTranscribable(m: Message): boolean {
  if (m.type === 'progress') return false
  if (m.type !== 'attachment') return true
  const attachment = m.attachment
  if (attachment.type === 'hook') return attachment.outcome !== 'text'
  if (PERSISTED_ATTACHMENT_TYPES.has(attachment.type)) return true
  if (attachment.capsuleReceipt) return true
  return transcriptProjector().hasApiAttachment(attachment)
}

function transformMessagesForExternalTranscript(messages: Transcript): Transcript {
  return messages.filter(m => !((m.type === 'assistant' || m.type === 'user') && Array.isArray(m.message.content) && m.message.content.length === 0))
}
