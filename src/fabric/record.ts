// ============================================================================
//  fabric/record — the versioned Mercury record model.
//
//  Mercury records what happened in its OWN semantic vocabulary; provider
//  adapters translate at their leaves. This module is the domain core:
//  ZERO provider package imports, ever (prove-import-fence pins it).
//
// Envelope laws:
//    · identity is assigned at creation (RecordId; entry uuids brand over);
//    · creation order and latest-update order are distinct Ordinals
//      (JSON-safe decimal strings, scoped to the thread lineage);
//    · published LINES are immutable — settlement re-publishes under the
// identity law, never edits published bytes;
//    · wall-clock (occurredAt/observedAt) is descriptive, never ordering;
//    · unknown future kinds/blocks are RETAINED visibly, never erased;
//    · core behavior never inspects an opaque provider receipt payload.
//
//  THE IDENTITY LAW:
//    · recordId is MESSAGE identity, not line identity: the codec derives
//      it from the entry uuid (entryCodec envelope()), minting fresh only
//      for uuid-less lines — every re-publication of the same message
//      carries the SAME recordId.
//    · LINE identity is the pair (recordId, updateOrdinal), unique per
//      transcript file: every published line allocates a fresh
//      updateOrdinal. A creation line has updateOrdinal == creationOrdinal;
//      a settlement re-publication PRESERVES creationOrdinal, ADVANCES
//      updateOrdinal, and self-points `updates` (updates === recordId). The
//      writer's still-queued fast path swaps bytes in place, so a settled
//      message durably lands as EITHER one line (already settled) or two
//      (as-published + superseding) — never a third.
//    · readers fold LAST-WINS per recordId (shipped: sessionStorage
//      loading.ts messages.set — equivalently: max updateOrdinal wins).
//    · replay/fold kernels key lines on (recordId, updateOrdinal), NEVER on
//      recordId alone — unique-recordId keying collapses a supersession
//      chain into one key and loses lines (the red, absorbed by
//      scripts/model-transition/prove-transition-g05-recordid-law.ts).
//
//  SCHEMA_VERSION 1 typing depth (deliberate, recorded): the core semantic
//  families — input, output, content blocks, the tool lifecycle, settlement,
//  usage, outcomes, boundaries, receipts — are first-class typed payloads.
//  The long tail of UI notices and session-meta entries is covered by typed
//  KINDS whose structured remainder rides `fields` (validated object,
//  version-gated) — deepened per-consumer as later slices cut over. Nothing
//  is uncovered: the exhaustive classifier + the entry codec prove totality.
// ============================================================================
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

// ── actors and sources ──────────────────────────────────────────────────────

/** Who a record is attributed to. */
export type ActorRef =
  | { role: 'operator' }
  | { role: 'assistant'; model?: string }
  | { role: 'tool'; name: string }
  | { role: 'system' }
  | { role: 'peer'; whoId: string; who?: string }

/** Where a record entered the fabric. */
export type RecordSource =
  | { channel: 'interactive' }
  | { channel: 'sdk' }
  | { channel: 'task-notification' }
  | { channel: 'coordinator' }
  | { channel: 'channel-bus'; server: string }
  | { channel: 'recovery' }

// ── provider-neutral usage (A06: retains all current detail) ────────────────

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
  /** Provider fields the codec decoded but Mercury doesn't model — retained. */
  extra?: Record<string, unknown>
}

// ── content blocks (the neutral vocabulary; unknown kinds retained) ─────────

export type ContentBlock =
  /** `citations: null` is the wire's legal no-citations spelling — kept
   *  nullable end-to-end so the bridge round-trip stays byte-faithful. */
  | { kind: 'text'; text: string; citations?: unknown[] | null; extra?: Record<string, unknown> }
  | {
      /** `extra` retains provider continuation material (e.g. signatures)
       *  until the IDM-3/4 codecs seal it into real receipts. */
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
      /** Provider-decoded extras (caching markers etc.) retained. */
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
      /** A provider block Mercury has no native projection for — retained
       *  byte-faithfully and rendered as an unsupported-content row. */
      kind: 'opaque'
      provider: string
      blockType: string
      payload: unknown
    }

// ── terminal outcomes ───────────────────────────────────────────────────────

export type TurnOutcome =
  | { result: 'completed'; stopReason?: string | null; stopSequence?: string | null }
  | { result: 'refusal'; stopSequence?: string | null }
  | { result: 'context-limit'; stopSequence?: string | null }
  | { result: 'output-limit'; stopSequence?: string | null }
  | { result: 'interrupted'; phase?: 'stream' | 'tools' }
  | { result: 'cancelled' }
  | { result: 'error'; classification: string; detail?: string }

export type ToolOutcome = 'ok' | 'error' | 'aborted'

// ── record payloads by kind ─────────────────────────────────────────────────

export type RecordPayload =
  | {
      /** Operator/agent input (a user turn; tool results ride their own kind). */
      kind: 'input'
      content: string | ContentBlock[]
      meta?: InputMeta
    }
  | {
      /** A settled assistant/model output turn. */
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
      /** A tool call's terminal settlement (exactly once per callId). */
      kind: 'tool-settlement'
      callId: ToolCallId
      outcome: ToolOutcome
      /** Synthesized by the core (abort/fallback pairing), not the tool. */
      synthetic?: boolean
      result: string | ContentBlock[]
      structuredResult?: unknown
      sourceOutputRecord?: RecordId
      mcpMeta?: Record<string, unknown>
    }
  | {
      /** Streamed tool/hook progress (transient; bounded retention). */
      kind: 'progress'
      callId: ToolCallId
      parentCallId?: ToolCallId
      data: unknown
    }
  | {
      /** A context attachment threaded into the conversation. */
      kind: 'attachment'
      attachmentType: string
      fields: Record<string, unknown>
    }
  | {
      /** A UI/system notice (the system-message entry family). */
      kind: 'notice'
      noticeKind: string
      content?: string
      level?: string
      fields: Record<string, unknown>
    }
  | {
      /** A history boundary: compaction, microcompaction, fork, rewind. */
      kind: 'boundary'
      boundaryKind: 'compact' | 'microcompact' | 'fork' | 'rewind' | 'replacement'
      content?: string
      fields: Record<string, unknown>
      logicalParent?: RecordId
    }
  | {
      /** A sealed provider continuation receipt. Core code may carry
       *  and persist it but NEVER branches on payload internals. */
      kind: 'receipt'
      receiptId: ReceiptId
      provider: string
      codecVersion: number
      payload: unknown
    }
  | {
      /** Session metadata (the logs.ts Entry long tail): titles, tags, agent
       *  settings, snapshots, queue ops, worktree state, … */
      kind: 'session-meta'
      metaKind: string
      fields: Record<string, unknown>
    }
  | {
      /** A record kind from a NEWER schema — retained visibly, never dropped. */
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

// ── the envelope ────────────────────────────────────────────────────────────

export type MercuryRecord = {
  schemaVersion: number
  /** MESSAGE identity — stable across re-publications. */
  recordId: RecordId
  sessionId: SessionId
  threadId: ThreadId
  turnId?: TurnId
  itemId?: ItemId
  parentId?: RecordId
  /** A settlement/update record names the record it settles/updates.
   *  Self-pointing (updates === recordId) marks a superseding
   * re-publication of the SAME message. */
  updates?: RecordId
  /** First-publication order — PRESERVED by settlement re-publication. */
  creationOrdinal: Ordinal
  /** This LINE's publication order; (recordId, updateOrdinal) is line
   * identity — the replay/fold key. */
  updateOrdinal: Ordinal
  occurredAt: string
  observedAt?: string
  actor: ActorRef
  source: RecordSource
  payload: RecordPayload
  /** Bounded chain-carried metadata (entry fields the
   *  typed payload does not lift: gitBranch, agentName, promptId, …). Always
   *  a validated object; never a behavior switch for core code. */
  annotations?: Record<string, unknown>
}

/** Exhaustive kind classifier — the compile-time totality anchor. */
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
