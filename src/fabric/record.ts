import type { SessionId } from '../types/ids.js'
import type {
  ItemId,
  ReceiptId,
  RecordId,
  ThreadId,
  ToolCallId,
  TurnId,
} from './ids.js'
import type { Ordinal } from './ordinal.js'

export const SCHEMA_VERSION = 1


export type ActorRef =
  | { role: 'operator' }
  | { role: 'assistant'; model?: string }
  | { role: 'tool'; name: string }
  | { role: 'system' }
  | { role: 'peer'; whoId: string; who?: string }

export type RecordSource =
  | { channel: 'interactive' }
  | { channel: 'sdk' }
  | { channel: 'task-notification' }
  | { channel: 'coordinator' }
  | { channel: 'channel-bus'; server: string }
  | { channel: 'recovery' }


export type MercuryUsage = {
  inputTokens?: number
  outputTokens?: number
  cacheReadInputTokens?: number
  cacheCreationInputTokens?: number
  cacheCreation?: {
    ephemeral1hInputTokens: number
    ephemeral5mInputTokens: number
  }
  serviceTier?: string | null
  inferenceGeo?: string | null
  iterations?: number | null
  speed?: string | null
  extra?: Record<string, unknown>
}


export type ContentBlock =
  | { kind: 'text'; text: string; citations?: unknown[] | null; extra?: Record<string, unknown> }
  | {
      kind: 'reasoning'
      text: string
      receiptId?: ReceiptId
      extra?: Record<string, unknown>
    }
  | { kind: 'redacted-reasoning'; receiptId?: ReceiptId; extra?: Record<string, unknown> }
  | {
      kind: 'tool-use'
      callId: ToolCallId
      name: string
      input: unknown
      extra?: Record<string, unknown>
    }
  | {
      kind: 'tool-result'
      callId: ToolCallId
      body?: string | ContentBlock[]
      isError?: boolean
      extra?: Record<string, unknown>
    }
  | { kind: 'image'; source: unknown; pasteId?: number; extra?: Record<string, unknown> }
  | { kind: 'document'; source: unknown; extra?: Record<string, unknown> }
  | {
      kind: 'opaque'
      provider: string
      blockType: string
      payload: unknown
    }


export type TurnOutcome =
  | { result: 'completed'; stopReason?: string | null; stopSequence?: string | null }
  | { result: 'refusal'; stopSequence?: string | null }
  | { result: 'context-limit'; stopSequence?: string | null }
  | { result: 'output-limit'; stopSequence?: string | null }
  | { result: 'interrupted'; phase?: 'stream' | 'tools' }
  | { result: 'cancelled' }
  | { result: 'error'; classification: string; detail?: string }

export type ToolOutcome = 'ok' | 'error' | 'aborted'


export type RecordPayload =
  | {
      kind: 'input'
      content: string | ContentBlock[]
      meta?: InputMeta
    }
  | {
      kind: 'output'
      model: string
      providerMessageId?: string
      content: ContentBlock[]
      usage: MercuryUsage
      outcome: TurnOutcome
      requestId?: string
      receiptId?: ReceiptId
      meta?: OutputMeta
    }
  | {
      kind: 'tool-settlement'
      callId: ToolCallId
      outcome: ToolOutcome
      synthetic?: boolean
      result: string | ContentBlock[]
      structuredResult?: unknown
      sourceOutputRecord?: RecordId
      mcpMeta?: Record<string, unknown>
    }
  | {
      kind: 'progress'
      callId: ToolCallId
      parentCallId?: ToolCallId
      data: unknown
    }
  | {
      kind: 'attachment'
      attachmentType: string
      fields: Record<string, unknown>
    }
  | {
      kind: 'notice'
      noticeKind: string
      content?: string
      level?: string
      fields: Record<string, unknown>
    }
  | {
      kind: 'boundary'
      boundaryKind: 'compact' | 'microcompact' | 'fork' | 'rewind' | 'replacement'
      content?: string
      fields: Record<string, unknown>
      logicalParent?: RecordId
    }
  | {
      kind: 'receipt'
      receiptId: ReceiptId
      provider: string
      codecVersion: number
      payload: unknown
    }
  | {
      kind: 'session-meta'
      metaKind: string
      fields: Record<string, unknown>
    }
  | {
      kind: 'unknown-retained'
      sourceKind: string
      fields: Record<string, unknown>
    }

export type InputMeta = {
  hiddenFromModel?: boolean
  hiddenFromTranscript?: boolean
  isVirtual?: boolean
  isCompactSummary?: boolean
  summarizeMetadata?: Record<string, unknown>
  toolUseResult?: unknown
  imagePasteIds?: number[]
  sourceToolAssistantRecord?: RecordId
  sourceToolCallId?: ToolCallId
  planContent?: string
  permissionMode?: string
  mcpMeta?: Record<string, unknown>
}

export type OutputMeta = {
  hiddenFromTranscript?: boolean
  isVirtual?: boolean
  isApiErrorNotice?: boolean
  errorClassification?: string
  errorDetails?: string
  apiError?: string
  advisorModel?: string
}

export type RecordKind = RecordPayload['kind']


export type MercuryRecord = {
  schemaVersion: number
  recordId: RecordId
  sessionId: SessionId
  threadId: ThreadId
  turnId?: TurnId
  itemId?: ItemId
  parentId?: RecordId
  updates?: RecordId
  creationOrdinal: Ordinal
  updateOrdinal: Ordinal
  occurredAt: string
  observedAt?: string
  actor: ActorRef
  source: RecordSource
  payload: RecordPayload
  annotations?: Record<string, unknown>
}

export function classifyRecordKind(payload: RecordPayload): RecordKind {
  switch (payload.kind) {
    case 'input':
    case 'output':
    case 'tool-settlement':
    case 'progress':
    case 'attachment':
    case 'notice':
    case 'boundary':
    case 'receipt':
    case 'session-meta':
    case 'unknown-retained':
      return payload.kind
    default: {
      const _exhaustive: never = payload
      return _exhaustive
    }
  }
}
