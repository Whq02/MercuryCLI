import type { UUID } from 'crypto'
import { COMMAND_NAME_TAG } from '../../constants/xml.js'
import type {
  AttributionSnapshotEntry,
  FileHistorySnapshotEntry,
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
import type { FileHistorySnapshot } from '../../types/fileHistory.js'
import { extractTag } from '../messages/text.js'
import { stripTerminalControls } from '../stringUtils.js'
import { transcriptRows } from './rowGraph.js'
import { isBuiltInCommandName } from './builtInCommands.js'
import { transcriptProjector } from './transcriptProjector.js'
import { notBuilt, type Unbuilt } from '../../pi/holes.js'

export function extractFirstPrompt(transcript: TranscriptMessage[]): string {
  return notBuilt('src/utils/sessionStorage/chain.ts:27')
}

export function getFirstMeaningfulUserMessageTextContent<T extends Message>(
  transcript: T[],
): string | undefined {
  return notBuilt('src/utils/sessionStorage/chain.ts:34')
}

export function removeExtraFields(
  transcript: TranscriptMessage[],
): SerializedMessage[] {
  return notBuilt('src/utils/sessionStorage/chain.ts:61')
}

export function applyPreservedSegmentRelinks(
  messages: Map<UUID, TranscriptMessage>,
): void {
  return notBuilt('src/utils/sessionStorage/chain.ts:67')
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
  return notBuilt('src/utils/sessionStorage/chain.ts:96')
}

export function buildConversationChain(
  messages: Map<UUID, TranscriptMessage>,
  leafMessage: TranscriptMessage,
): TranscriptMessage[] {
  return notBuilt('src/utils/sessionStorage/chain.ts:103')
}

export function buildScreenConversation(
  messages: Map<UUID, TranscriptMessage>,
): TranscriptMessage[] {
  return notBuilt('src/utils/sessionStorage/chain.ts:110')
}

export function checkResumeConsistency(chain: Message[]): void {
  return notBuilt('src/utils/sessionStorage/chain.ts:116')
}

export function buildFileHistorySnapshotChain(
  fileHistorySnapshots: Map<UUID, FileHistorySnapshotEntry>,
  conversation: TranscriptMessage[],
): FileHistorySnapshot[] {
  return notBuilt('src/utils/sessionStorage/chain.ts:132')
}

export function buildAttributionSnapshotChain(
  attributionSnapshots: Map<UUID, AttributionSnapshotEntry>,
  _conversation: TranscriptMessage[],
): AttributionSnapshotEntry[] {
  return notBuilt('src/utils/sessionStorage/chain.ts:151')
}

export function cleanForTranscript(
  messages: Message[],
  allMessages?: readonly Message[],
): Transcript {
  return notBuilt('src/utils/sessionStorage/chain.ts:158')
}

export type Transcript = Unbuilt[]

export function writtenChainTail(messages: Message[], parentUuid?: UUID | null): UUID | undefined {
  return cleanForTranscript(messages).at(-1)?.uuid ?? parentUuid ?? undefined
}

export function isTranscribable(m: Message): boolean {
  return notBuilt('src/utils/sessionStorage/chain.ts:177')
}

function transformMessagesForExternalTranscript(messages: Transcript): Transcript {
  return messages.filter(m => !((m.type === 'assistant' || m.type === 'user') && Array.isArray(m.message.content) && m.message.content.length === 0))
}
