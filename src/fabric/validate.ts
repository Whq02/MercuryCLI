// ============================================================================
//  fabric/validate — runtime validation for the Mercury record model
// Every durable shape has an explicit schema version and a
//  runtime decoder; `unknown` is accepted at the boundary and either
//  validates or returns a typed issue — no compile-time cast ever reaches a
//  consumer. Unknown record kinds validate into `unknown-retained` rather
// than failing (the retention law); structural corruption fails loudly.
// ============================================================================
import { z } from 'zod/v4'
import type { MercuryRecord } from './record.js'
import { SCHEMA_VERSION } from './record.js'
import { isOrdinal } from './ordinal.js'

const ordinal = z.string().refine(isOrdinal, 'canonical decimal-string ordinal')

const actorRef = z.discriminatedUnion('role', [
  z.object({ role: z.literal('operator') }),
  z.object({ role: z.literal('assistant'), model: z.string().optional() }),
  z.object({ role: z.literal('tool'), name: z.string() }),
  z.object({ role: z.literal('system') }),
  z.object({ role: z.literal('peer'), whoId: z.string(), who: z.string().optional() }),
])

const recordSource = z.discriminatedUnion('channel', [
  z.object({ channel: z.literal('interactive') }),
  z.object({ channel: z.literal('sdk') }),
  z.object({ channel: z.literal('task-notification') }),
  z.object({ channel: z.literal('coordinator') }),
  z.object({ channel: z.literal('channel-bus'), server: z.string() }),
  z.object({ channel: z.literal('recovery') }),
])

const usage = z
  .object({
    inputTokens: z.number().optional(),
    outputTokens: z.number().optional(),
    cacheReadInputTokens: z.number().optional(),
    cacheCreationInputTokens: z.number().optional(),
    cacheCreation: z
      .object({
        ephemeral1hInputTokens: z.number(),
        ephemeral5mInputTokens: z.number(),
      })
      .strict()
      .optional(),
    serviceTier: z.string().nullable().optional(),
    inferenceGeo: z.string().nullable().optional(),
    iterations: z.number().nullable().optional(),
    speed: z.string().nullable().optional(),
    extra: z.record(z.string(), z.unknown()).optional(),
  })
  .strict()

const contentBlock: z.ZodType<unknown> = z.lazy(() =>
  z.discriminatedUnion('kind', [
    // citations is nullable: `citations: null` is the wire's legal "no
    // citations" spelling on text blocks (the Anthropic wire itself, and
    // every routed lane's minted blocks). A validator that demanded an
    // array classified the SETTLED final-text record of glm-*/gpt-* agent
    // turns invalid, so decoders dropped the agent's answer — the
    // /workflows inspector's empty OUT section).
    z.object({ kind: z.literal('text'), text: z.string(), citations: z.array(z.unknown()).nullable().optional(), extra: z.record(z.string(), z.unknown()).optional() }).strict(),
    z.object({ kind: z.literal('reasoning'), text: z.string(), receiptId: z.string().optional(), extra: z.record(z.string(), z.unknown()).optional() }).strict(),
    z.object({ kind: z.literal('redacted-reasoning'), receiptId: z.string().optional(), extra: z.record(z.string(), z.unknown()).optional() }).strict(),
    z.object({ kind: z.literal('tool-use'), callId: z.string(), name: z.string(), input: z.unknown(), extra: z.record(z.string(), z.unknown()).optional() }).strict(),
    z.object({ kind: z.literal('tool-result'), callId: z.string(), body: z.union([z.string(), z.array(contentBlock)]).optional(), isError: z.boolean().optional(), extra: z.record(z.string(), z.unknown()).optional() }).strict(),
    z.object({ kind: z.literal('image'), source: z.unknown(), pasteId: z.number().optional(), extra: z.record(z.string(), z.unknown()).optional() }).strict(),
    z.object({ kind: z.literal('document'), source: z.unknown(), extra: z.record(z.string(), z.unknown()).optional() }).strict(),
    z.object({ kind: z.literal('opaque'), provider: z.string(), blockType: z.string(), payload: z.unknown() }).strict(),
  ]),
)

const content = z.union([z.string(), z.array(contentBlock)])

const turnOutcome = z.discriminatedUnion('result', [
  z.object({ result: z.literal('completed'), stopReason: z.string().nullable().optional(), stopSequence: z.string().nullable().optional() }),
  z.object({ result: z.literal('refusal'), stopSequence: z.string().nullable().optional() }),
  z.object({ result: z.literal('context-limit'), stopSequence: z.string().nullable().optional() }),
  z.object({ result: z.literal('output-limit'), stopSequence: z.string().nullable().optional() }),
  z.object({ result: z.literal('interrupted'), phase: z.enum(['stream', 'tools']).optional() }),
  z.object({ result: z.literal('cancelled') }),
  z.object({ result: z.literal('error'), classification: z.string(), detail: z.string().optional() }),
])

const fields = z.record(z.string(), z.unknown())

const payload = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('input'),
      content,
      meta: fields.optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('output'),
      model: z.string(),
      providerMessageId: z.string().optional(),
      content: z.array(contentBlock),
      usage,
      outcome: turnOutcome,
      requestId: z.string().optional(),
      receiptId: z.string().optional(),
      meta: fields.optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('tool-settlement'),
      callId: z.string(),
      outcome: z.enum(['ok', 'error', 'aborted']),
      synthetic: z.boolean().optional(),
      result: z.union([z.string(), z.array(contentBlock)]),
      structuredResult: z.unknown().optional(),
      sourceOutputRecord: z.string().optional(),
      mcpMeta: fields.optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('progress'),
      callId: z.string(),
      parentCallId: z.string().optional(),
      data: z.unknown(),
    })
    .strict(),
  z.object({ kind: z.literal('attachment'), attachmentType: z.string(), fields }).strict(),
  z
    .object({
      kind: z.literal('notice'),
      noticeKind: z.string(),
      content: z.string().optional(),
      level: z.string().optional(),
      fields,
    })
    .strict(),
  z
    .object({
      kind: z.literal('boundary'),
      boundaryKind: z.enum(['compact', 'microcompact', 'fork', 'rewind', 'replacement']),
      content: z.string().optional(),
      fields,
      logicalParent: z.string().optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('receipt'),
      receiptId: z.string(),
      provider: z.string(),
      codecVersion: z.number(),
      payload: z.unknown(),
    })
    .strict(),
  z.object({ kind: z.literal('session-meta'), metaKind: z.string(), fields }).strict(),
  z.object({ kind: z.literal('unknown-retained'), sourceKind: z.string(), fields }).strict(),
])

const recordSchema = z
  .object({
    schemaVersion: z.number().int().min(1),
    recordId: z.string().min(1),
    sessionId: z.string().min(1),
    threadId: z.string().min(1),
    turnId: z.string().optional(),
    itemId: z.string().optional(),
    parentId: z.string().optional(),
    updates: z.string().optional(),
    creationOrdinal: ordinal,
    updateOrdinal: ordinal,
    occurredAt: z.string().min(1),
    observedAt: z.string().optional(),
    actor: actorRef,
    source: recordSource,
    payload,
    annotations: fields.optional(),
  })
  .strict()

export type ValidationIssue = {
  path: string
  message: string
}

export type ValidationResult =
  | { ok: true; record: MercuryRecord }
  | { ok: false; issues: ValidationIssue[] }

/** Decode an unknown value into a MercuryRecord, or a typed issue list.
 *  A record from a NEWER schema version with an unrecognized payload kind is
 *  reshaped to `unknown-retained` (retention law) rather than rejected —
 *  structural corruption still fails. */
export function validateRecord(value: unknown): ValidationResult {
  const first = recordSchema.safeParse(value)
  if (first.success) return { ok: true, record: first.data as MercuryRecord }

  // Retention path: envelope intact + newer schema + unknown payload kind.
  if (typeof value === 'object' && value !== null) {
    const v = value as Record<string, unknown>
    const p = v.payload as Record<string, unknown> | undefined
    if (
      typeof v.schemaVersion === 'number' &&
      v.schemaVersion > SCHEMA_VERSION &&
      p !== null &&
      typeof p === 'object' &&
      typeof p.kind === 'string'
    ) {
      const retained = {
        ...v,
        schemaVersion: SCHEMA_VERSION,
        payload: {
          kind: 'unknown-retained',
          sourceKind: p.kind,
          fields: { schemaVersion: v.schemaVersion, payload: p },
        },
      }
      const second = recordSchema.safeParse(retained)
      if (second.success) return { ok: true, record: second.data as MercuryRecord }
    }
  }

  return {
    ok: false,
    issues: first.error.issues.map(i => ({
      path: i.path.join('.'),
      message: i.message,
    })),
  }
}
