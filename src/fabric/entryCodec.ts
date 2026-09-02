// ============================================================================
//  fabric/entryCodec — the total entry↔record codec.
//
//  Mercury's durable transcript format is the versioned MercuryRecord
//  envelope; the app's in-memory transcript vocabulary is the entry shape
//  (types/logs.ts + types/message.ts). This is the ONE module allowed to
//  know both spellings: the write seam encodes an entry into a validated
//  MercuryRecord, and the read seam projects it back losslessly.
//
//  The lossless law, by construction:
//    · envelope identity/ordering fields are DERIVED from the entry (uuid,
//      timestamp, parentUuid, sessionId, agentId/isSidechain) — the source
//      spellings stay in the entry's rest-carry, so projection never has to
//      reconstruct them from the envelope;
//    · payload semantics are MOVED (content blocks, usage, outcomes, …) and
//      the projection is their exact inverse;
//    · every field the lift does not name lands in a rest-carry
//      (annotations / fields / extra) and is spread back on projection —
//      no entry field can be silently dropped, known or unknown.
//
//  The codec bar (prove-fabric-domain.ts): for every entry E,
//  JSON(recordToEntry(entryToRecord(E))) deep-equals JSON(E), and
//  entryToRecord(E) passes validateRecord — the write seam and the read
//  seam are exact inverses through the durable format.
// ============================================================================
import type { SessionId } from '../types/ids.js'
import { asRecordId, asThreadId, asToolCallId, MAIN_THREAD, mintRecordId, type ThreadId } from './ids.js'
import type { Ordinal } from './ordinal.js'
import type {
  ActorRef,
  ContentBlock,
  MercuryRecord,
  MercuryUsage,
  RecordPayload,
  RecordSource,
  TurnOutcome,
} from './record.js'
import { SCHEMA_VERSION } from './record.js'

type Raw = Record<string, unknown>

export type EncodeContext = {
  sessionId: SessionId
  nextOrdinal: () => Ordinal
  /** Fallback occurredAt for entries without a timestamp field. */
  observedAt: string
  /** Record provenance — the writer stamps its real channel. */
  source: RecordSource
}

// ── small helpers ───────────────────────────────────────────────────────────

/** Split `obj` into the named fields and the rest-carry. */
function take(obj: Raw, keys: string[]): { picked: Raw; rest: Raw } {
  const picked: Raw = {}
  const rest: Raw = {}
  for (const [k, v] of Object.entries(obj)) {
    if (keys.includes(k)) picked[k] = v
    else rest[k] = v
  }
  return { picked, rest }
}

const nonEmpty = (o: Raw): Raw | undefined => (Object.keys(o).length > 0 ? o : undefined)

// ── content-block mapping (assistant + user param blocks) ───────────────────

const USAGE_LIFT: Array<[wire: string, mercury: keyof MercuryUsage]> = [
  ['input_tokens', 'inputTokens'],
  ['output_tokens', 'outputTokens'],
  ['cache_read_input_tokens', 'cacheReadInputTokens'],
  ['cache_creation_input_tokens', 'cacheCreationInputTokens'],
  ['service_tier', 'serviceTier'],
  ['inference_geo', 'inferenceGeo'],
  ['iterations', 'iterations'],
  ['speed', 'speed'],
]

function mapUsage(u: Raw): MercuryUsage {
  const lifted: Raw = {}
  const rest: Raw = {}
  const liftedKeys = new Set(USAGE_LIFT.map(([l]) => l))
  for (const [k, v] of Object.entries(u)) {
    if (!liftedKeys.has(k)) rest[k] = v
  }
  for (const [wire, mercury] of USAGE_LIFT) {
    if (wire in u) lifted[mercury] = u[wire]
  }
  if ('cache_creation' in rest) {
    const cc = rest.cache_creation as Raw | null
    if (cc && typeof cc === 'object' && 'ephemeral_1h_input_tokens' in cc && 'ephemeral_5m_input_tokens' in cc && Object.keys(cc).length === 2) {
      lifted.cacheCreation = {
        ephemeral1hInputTokens: cc.ephemeral_1h_input_tokens,
        ephemeral5mInputTokens: cc.ephemeral_5m_input_tokens,
      }
      delete rest.cache_creation
    }
  }
  const out = lifted as unknown as MercuryUsage
  const extra = nonEmpty(rest)
  if (extra) out.extra = extra
  return out
}

function projectUsage(u: MercuryUsage): Raw {
  const out: Raw = {}
  for (const [wire, mercury] of USAGE_LIFT) {
    if (mercury in u) out[wire] = (u as Raw)[mercury as string]
  }
  if (u.cacheCreation) {
    out.cache_creation = {
      ephemeral_1h_input_tokens: u.cacheCreation.ephemeral1hInputTokens,
      ephemeral_5m_input_tokens: u.cacheCreation.ephemeral5mInputTokens,
    }
  }
  if (u.extra) Object.assign(out, u.extra)
  return out
}

function mapBlock(b: Raw): ContentBlock {
  const t = b.type
  if (t === 'text') {
    const { picked, rest } = take(b, ['type', 'text', 'citations'])
    const block: Raw = { kind: 'text', text: picked.text }
    if ('citations' in picked) block.citations = picked.citations
    const extra = nonEmpty(rest)
    if (extra) block.extra = extra
    return block as unknown as ContentBlock
  }
  if (t === 'thinking') {
    const { picked, rest } = take(b, ['type', 'thinking'])
    const block: Raw = { kind: 'reasoning', text: picked.thinking }
    const extra = nonEmpty(rest)
    if (extra) block.extra = extra
    return block as unknown as ContentBlock
  }
  if (t === 'redacted_thinking') {
    const { rest } = take(b, ['type'])
    const block: Raw = { kind: 'redacted-reasoning' }
    const extra = nonEmpty(rest)
    if (extra) block.extra = extra
    return block as unknown as ContentBlock
  }
  if (t === 'tool_use') {
    const { picked, rest } = take(b, ['type', 'id', 'name', 'input'])
    const block: Raw = {
      kind: 'tool-use',
      callId: asToolCallId(String(picked.id)),
      name: picked.name,
      input: picked.input,
    }
    const extra = nonEmpty(rest)
    if (extra) block.extra = extra
    return block as unknown as ContentBlock
  }
  if (t === 'tool_result') {
    const { picked, rest } = take(b, ['type', 'tool_use_id', 'content', 'is_error'])
    const block: Raw = { kind: 'tool-result', callId: asToolCallId(String(picked.tool_use_id)) }
    if ('content' in picked) {
      block.body = Array.isArray(picked.content)
        ? (picked.content as Raw[]).map(mapBlock)
        : picked.content
    }
    if ('is_error' in picked) block.isError = picked.is_error
    const extra = nonEmpty(rest)
    if (extra) block.extra = extra
    return block as unknown as ContentBlock
  }
  if (t === 'image') {
    const { picked, rest } = take(b, ['type', 'source'])
    const block: Raw = { kind: 'image', source: picked.source }
    const extra = nonEmpty(rest)
    if (extra) block.extra = extra
    return block as unknown as ContentBlock
  }
  if (t === 'document') {
    const { picked, rest } = take(b, ['type', 'source'])
    const block: Raw = { kind: 'document', source: picked.source }
    const extra = nonEmpty(rest)
    if (extra) block.extra = extra
    return block as unknown as ContentBlock
  }
  return { kind: 'opaque', provider: 'anthropic', blockType: String(t), payload: b }
}

function projectBlock(b: ContentBlock): Raw {
  switch (b.kind) {
    case 'text': {
      const out: Raw = { type: 'text', text: b.text }
      if ('citations' in b) out.citations = b.citations
      if (b.extra) Object.assign(out, b.extra)
      return out
    }
    case 'reasoning': {
      const out: Raw = { type: 'thinking', thinking: b.text }
      if (b.extra) Object.assign(out, b.extra)
      return out
    }
    case 'redacted-reasoning': {
      const out: Raw = { type: 'redacted_thinking' }
      if (b.extra) Object.assign(out, b.extra)
      return out
    }
    case 'tool-use': {
      const out: Raw = { type: 'tool_use', id: b.callId, name: b.name, input: b.input }
      if (b.extra) Object.assign(out, b.extra)
      return out
    }
    case 'tool-result': {
      const out: Raw = { type: 'tool_result', tool_use_id: b.callId }
      if ('body' in b && b.body !== undefined) {
        out.content = Array.isArray(b.body) ? b.body.map(projectBlock) : b.body
      }
      if ('isError' in b) out.is_error = b.isError
      if (b.extra) Object.assign(out, b.extra)
      return out
    }
    case 'image': {
      const out: Raw = { type: 'image', source: b.source }
      if (b.extra) Object.assign(out, b.extra)
      return out
    }
    case 'document': {
      const out: Raw = { type: 'document', source: b.source }
      if (b.extra) Object.assign(out, b.extra)
      return out
    }
    case 'opaque':
      return b.payload as Raw
    default: {
      const _exhaustive: never = b
      return _exhaustive
    }
  }
}

// ── outcome mapping (bijective over the entry stop_reason vocabulary) ───────

function mapOutcome(stopReason: unknown, stopSequence: unknown): TurnOutcome {
  const special: Record<string, 'refusal' | 'context-limit' | 'output-limit'> = {
    refusal: 'refusal',
    model_context_window_exceeded: 'context-limit',
    max_tokens: 'output-limit',
  }
  const kind = typeof stopReason === 'string' ? special[stopReason] : undefined
  const out: TurnOutcome = kind ? { result: kind } : { result: 'completed' }
  if (!kind && stopReason !== undefined) (out as { stopReason?: unknown }).stopReason = stopReason
  if (stopSequence !== undefined) (out as { stopSequence?: unknown }).stopSequence = stopSequence
  return out
}

function projectOutcome(o: TurnOutcome): Raw {
  switch (o.result) {
    case 'refusal':
    case 'context-limit':
    case 'output-limit': {
      const reasons = { refusal: 'refusal', 'context-limit': 'model_context_window_exceeded', 'output-limit': 'max_tokens' } as const
      const out: Raw = { stop_reason: reasons[o.result] }
      if ('stopSequence' in o) out.stop_sequence = o.stopSequence
      return out
    }
    case 'completed': {
      const out: Raw = {}
      if ('stopReason' in o) out.stop_reason = o.stopReason
      if ('stopSequence' in o) out.stop_sequence = o.stopSequence
      return out
    }
    // The reducer-only outcomes never come from the entry codec.
    case 'interrupted':
    case 'cancelled':
    case 'error':
      return { stop_reason: null, stop_sequence: null }
    default: {
      const _exhaustive: never = o
      return _exhaustive
    }
  }
}

// ── the envelope derivation ─────────────────────────────────────────────────

function deriveThread(entry: Raw): ThreadId {
  if (typeof entry.agentId === 'string' && entry.agentId) return asThreadId(`agent:${entry.agentId}`)
  if (entry.isSidechain === true) return asThreadId('sidechain')
  return MAIN_THREAD
}

/** Envelope identity is DERIVED, never moved: uuid/timestamp/parentUuid/
 *  sessionId stay in the entry's rest-carry (annotations/fields), so the
 *  projection restores their spellings exactly. */
function envelope(
  entry: Raw,
  ctx: EncodeContext,
  actor: ActorRef,
  payload: RecordPayload,
  annotations: Raw | undefined,
): MercuryRecord {
  const ordinal = ctx.nextOrdinal()
  const rec: MercuryRecord = {
    schemaVersion: SCHEMA_VERSION,
    recordId: typeof entry.uuid === 'string' && entry.uuid ? asRecordId(entry.uuid) : mintRecordId(),
    sessionId: (typeof entry.sessionId === 'string' && entry.sessionId ? entry.sessionId : ctx.sessionId) as SessionId,
    threadId: deriveThread(entry),
    creationOrdinal: ordinal,
    updateOrdinal: ordinal,
    occurredAt: typeof entry.timestamp === 'string' && entry.timestamp ? entry.timestamp : ctx.observedAt,
    actor,
    source: ctx.source,
    payload,
  }
  if (typeof entry.parentUuid === 'string' && entry.parentUuid) rec.parentId = asRecordId(entry.parentUuid)
  if (annotations) rec.annotations = annotations
  return rec
}

// ── per-family encoding ─────────────────────────────────────────────────────

export function entryToRecord(entry: Raw, ctx: EncodeContext): MercuryRecord {
  const t = entry.type

  if (t === 'assistant') {
    const { picked, rest } = take(entry, ['type', 'message'])
    const msg = (picked.message ?? {}) as Raw
    const m = take(msg, ['content', 'model', 'id', 'usage', 'stop_reason', 'stop_sequence'])
    const content = Array.isArray(m.picked.content) ? (m.picked.content as Raw[]).map(mapBlock) : []
    const payload: RecordPayload = {
      kind: 'output',
      model: String(m.picked.model ?? ''),
      content,
      usage: mapUsage((m.picked.usage ?? {}) as Raw),
      outcome: mapOutcome(
        'stop_reason' in m.picked ? m.picked.stop_reason : undefined,
        'stop_sequence' in m.picked ? m.picked.stop_sequence : undefined,
      ),
    }
    if ('id' in m.picked) payload.providerMessageId = String(m.picked.id)
    const apiRest = nonEmpty(m.rest)
    const meta: Raw = {}
    if (apiRest) meta.apiRest = apiRest
    if (!('stop_reason' in m.picked)) meta.noStopReason = true
    if (!('usage' in m.picked)) meta.noUsage = true
    if (Object.keys(meta).length > 0) payload.meta = meta
    return envelope(entry, ctx, { role: 'assistant', model: payload.model }, payload, nonEmpty(rest))
  }

  if (t === 'user') {
    const { picked, rest } = take(entry, ['type', 'message'])
    const msg = (picked.message ?? {}) as Raw
    const m = take(msg, ['content'])
    const content =
      typeof m.picked.content === 'string'
        ? m.picked.content
        : Array.isArray(m.picked.content)
          ? (m.picked.content as Raw[]).map(mapBlock)
          : ''
    const payload: RecordPayload = { kind: 'input', content }
    const meta: Raw = {}
    const msgRest = nonEmpty(m.rest)
    if (msgRest) meta.msgRest = msgRest
    if (Object.keys(meta).length > 0) payload.meta = meta
    return envelope(entry, ctx, { role: 'operator' }, payload, nonEmpty(rest))
  }

  if (t === 'progress') {
    // Earlier builds persisted progress lines; the codec keeps the family
    // total so those files decode whole.
    const { picked, rest } = take(entry, ['type', 'data', 'toolUseID', 'parentToolUseID'])
    const payload: RecordPayload = {
      kind: 'progress',
      callId: asToolCallId(String(picked.toolUseID ?? '')),
      data: picked.data,
    }
    if ('parentToolUseID' in picked) payload.parentCallId = asToolCallId(String(picked.parentToolUseID))
    return envelope(entry, ctx, { role: 'system' }, payload, nonEmpty(rest))
  }

  if (t === 'attachment') {
    const { picked, rest } = take(entry, ['type', 'attachment'])
    const att = (picked.attachment ?? {}) as Raw
    const a = take(att, ['type'])
    const payload: RecordPayload = {
      kind: 'attachment',
      attachmentType: String(a.picked.type ?? ''),
      fields: a.rest,
    }
    return envelope(entry, ctx, { role: 'system' }, payload, nonEmpty(rest))
  }

  if (t === 'system') {
    const sub = entry.subtype
    if (
      sub === 'compact_boundary' ||
      sub === 'microcompact_boundary' ||
      sub === 'fork_boundary' ||
      sub === 'rewind_boundary'
    ) {
      // Branch creation writes the fork/rewind boundary through this same
      // derivation.
      const { picked, rest } = take(entry, ['type', 'subtype', 'content', 'logicalParentUuid'])
      const payload: RecordPayload = {
        kind: 'boundary',
        boundaryKind:
          sub === 'compact_boundary'
            ? 'compact'
            : sub === 'microcompact_boundary'
              ? 'microcompact'
              : sub === 'fork_boundary'
                ? 'fork'
                : 'rewind',
        fields: rest,
      }
      if ('content' in picked) payload.content = String(picked.content)
      if (typeof picked.logicalParentUuid === 'string') payload.logicalParent = asRecordId(picked.logicalParentUuid)
      // Derived spellings stay inside fields via rest (uuid/timestamp/...)
      return envelope(entry, ctx, { role: 'system' }, payload, undefined)
    }
    const { picked, rest } = take(entry, ['type', 'subtype', 'content', 'level'])
    const payload: RecordPayload = {
      kind: 'notice',
      noticeKind: String(sub ?? ''),
      fields: rest,
    }
    if ('content' in picked && typeof picked.content === 'string') payload.content = picked.content
    else if ('content' in picked) payload.fields.content = picked.content
    if ('level' in picked && typeof picked.level === 'string') payload.level = picked.level
    return envelope(entry, ctx, { role: 'system' }, payload, undefined)
  }

  // The logs.ts Entry long tail + anything future: session-meta / retained.
  if (typeof t === 'string') {
    const { rest } = take(entry, ['type'])
    const payload: RecordPayload = { kind: 'session-meta', metaKind: t, fields: rest }
    return envelope(entry, ctx, { role: 'system' }, payload, undefined)
  }

  return envelope(
    entry,
    ctx,
    { role: 'system' },
    { kind: 'unknown-retained', sourceKind: String(t), fields: { line: entry } },
    undefined,
  )
}

// ── the inverse projection ──────────────────────────────────────────────────

export function recordToEntry(rec: MercuryRecord): Raw {
  const p = rec.payload

  if (p.kind === 'output') {
    const meta = (p.meta ?? {}) as Raw
    const message: Raw = {
      content: p.content.map(projectBlock),
      model: p.model,
    }
    if ('providerMessageId' in p) message.id = p.providerMessageId
    if (!meta.noUsage) message.usage = projectUsage(p.usage)
    if (!meta.noStopReason) Object.assign(message, projectOutcome(p.outcome))
    else {
      const oc = projectOutcome(p.outcome)
      delete oc.stop_reason
      if ('stop_sequence' in oc) message.stop_sequence = oc.stop_sequence
    }
    if (meta.apiRest) Object.assign(message, meta.apiRest as Raw)
    return { ...(rec.annotations ?? {}), type: 'assistant', message }
  }

  if (p.kind === 'input') {
    const meta = (p.meta ?? {}) as Raw
    const message: Raw = {
      content: typeof p.content === 'string' ? p.content : p.content.map(projectBlock),
    }
    if (meta.msgRest) Object.assign(message, meta.msgRest as Raw)
    return { ...(rec.annotations ?? {}), type: 'user', message }
  }

  if (p.kind === 'progress') {
    const out: Raw = { ...(rec.annotations ?? {}), type: 'progress', data: p.data, toolUseID: p.callId }
    if ('parentCallId' in p) out.parentToolUseID = p.parentCallId
    return out
  }

  if (p.kind === 'attachment') {
    return {
      ...(rec.annotations ?? {}),
      type: 'attachment',
      attachment: { type: p.attachmentType, ...p.fields },
    }
  }

  if (p.kind === 'boundary') {
    const out: Raw = {
      ...p.fields,
      type: 'system',
      subtype:
        p.boundaryKind === 'compact'
          ? 'compact_boundary'
          : p.boundaryKind === 'microcompact'
            ? 'microcompact_boundary'
            : p.boundaryKind === 'fork'
              ? 'fork_boundary'
              : p.boundaryKind === 'rewind'
                ? 'rewind_boundary'
                : 'microcompact_boundary',
    }
    if ('content' in p) out.content = p.content
    if (p.logicalParent !== undefined) out.logicalParentUuid = p.logicalParent
    return out
  }

  if (p.kind === 'notice') {
    const out: Raw = { ...p.fields, type: 'system', subtype: p.noticeKind }
    if ('content' in p) out.content = p.content
    if ('level' in p) out.level = p.level
    return out
  }

  if (p.kind === 'session-meta') {
    return { type: p.metaKind, ...p.fields }
  }

  if (p.kind === 'unknown-retained') {
    return (p.fields.line ?? p.fields) as Raw
  }

  // Reducer-era kinds (tool-settlement / receipt) have no entry projection
  // yet — they arrive with their own consumers.
  throw new Error(`no entry projection for record kind ${p.kind}`)
}
