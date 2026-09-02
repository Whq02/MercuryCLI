// ============================================================================
//  tools/MemoryTools — the four memory verbs as first-class tools.
//
//  Retain/Recall/Reflect/Correct over memdir/memoryVerbs (which rides the
//  MNEME owners). Availability mirrors the backend exactly: MNEME on +
//  auto-memory on, or the whole family is out of the catalogue (with
//  /health saying why). Retain and Correct are write-classed; Recall and
//  Reflect never write. Reflect's synthesis is CITED or refused — the
//  anti-confabulation law is enforced in code, not prose.
// ============================================================================

import { z } from 'zod/v4'
import { buildTool, type ToolDef, type ToolUseContext } from '../../Tool.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { getSessionId } from '../../bootstrap/state.js'
import {
  correctMemory,
  memoryVerbsEnabled,
  readMemoryRecord,
  RECALL_RESULT_CAP_CHARS,
  recallQuery,
  retainItems,
  type CorrectOutcome,
  type MemoryReadResult,
  type RecallResult,
  type RetainItemOutcome,
} from '../../memdir/memoryVerbs.js'
import {
  CORRECT_DESCRIPTION,
  CORRECT_PROMPT,
  CORRECT_TOOL_NAME,
  RECALL_DESCRIPTION,
  RECALL_PROMPT,
  RECALL_TOOL_NAME,
  REFLECT_DESCRIPTION,
  REFLECT_PROMPT,
  REFLECT_TOOL_NAME,
  RETAIN_DESCRIPTION,
  RETAIN_PROMPT,
  RETAIN_TOOL_NAME,
} from './prompt.js'
import {
  renderCorrectResult,
  renderMemoryToolUse,
  renderRecallResult,
  renderReflectResult,
  renderRetainResult,
} from './UI.js'

function safeSession(): string {
  try {
    return String(getSessionId())
  } catch {
    return 'boot'
  }
}

// ── Retain ─────────────────────────────────────────────────────────────────

const retainSchema = lazySchema(() =>
  z.strictObject({
    items: z
      .array(
        z.strictObject({
          content: z.string().describe('One self-contained durable fact.'),
          context: z.string().optional().describe('Where the fact came from (provenance note).'),
          topic: z.string().optional().describe('Topic routing hint (slugified).'),
        }),
      )
      .min(1)
      .max(20)
      .describe('The facts to store.'),
  }),
)
type RetainSchema = ReturnType<typeof retainSchema>
export interface RetainOutput {
  outcomes: RetainItemOutcome[]
  stored: number
  refused: number
}

export const RetainTool = buildTool({
  name: RETAIN_TOOL_NAME,
  searchHint: 'store durable facts into project memory',
  maxResultSizeChars: 20_000,
  shouldDefer: true,
  get inputSchema(): RetainSchema {
    return retainSchema()
  },
  isEnabled() {
    return memoryVerbsEnabled()
  },
  isConcurrencySafe() {
    // Buffer appends are single atomic O_APPEND writes — concurrent Retain
    // calls (teammates included) interleave safely by construction.
    return true
  },
  isReadOnly() {
    return false
  },
  toAutoClassifierInput(input: z.infer<RetainSchema>) {
    return `retain ${input.items.length} fact(s)`
  },
  async description() {
    return RETAIN_DESCRIPTION
  },
  async prompt() {
    return RETAIN_PROMPT
  },
  async call(input: z.infer<RetainSchema>, context: ToolUseContext) {
    const outcomes = retainItems(input.items, {
      session: safeSession(),
      ...(context.agentId ? { agent: String(context.agentId) } : {}),
    })
    const stored = outcomes.filter(o => o.status === 'stored').length
    const refused = outcomes.filter(o => o.status === 'refused').length
    return { data: { outcomes, stored, refused } }
  },
  mapToolResultToToolResultBlockParam(output: RetainOutput, toolUseID) {
    const lines = output.outcomes.map(outcome =>
      outcome.status === 'refused'
        ? `- item ${outcome.index}: REFUSED — ${outcome.reason} (the fact was NOT stored)`
        : `- item ${outcome.index}: ${outcome.status} → ${outcome.id}`,
    )
    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content: `${output.stored} stored · ${output.refused} refused\n${lines.join('\n')}`,
      ...(output.refused > 0 && output.stored === 0 ? { is_error: true } : {}),
    }
  },
  renderToolUseMessage: input => renderMemoryToolUse('retain', input),
  renderToolResultMessage: renderRetainResult,
} satisfies ToolDef<RetainSchema, RetainOutput>)

// ── Recall ─────────────────────────────────────────────────────────────────

const recallSchema = lazySchema(() =>
  z
    .strictObject({
      query: z.string().optional().describe('Search memory (docs + pending observations).'),
      read: z.string().optional().describe('Read ONE full record by id (seq:<n> · doc:<slug> · pending:<ts>).'),
      limit: z.number().int().min(1).max(50).optional().describe('Max hits (default 12).'),
    })
    .refine(value => Boolean(value.query) !== Boolean(value.read), {
      message: 'pass exactly one of query or read',
    }),
)
type RecallSchema = ReturnType<typeof recallSchema>
export type RecallOutput =
  | ({ kind: 'hits' } & RecallResult)
  | ({ kind: 'record' } & MemoryReadResult)

export const RecallTool = buildTool({
  name: RECALL_TOOL_NAME,
  searchHint: 'search project memory with stable ids and provenance',
  // The verbs layer's render budget derives from this cap (one owner):
  // whole-doc reads stay under it, so the harness truncation seam can
  // never clip a row the seen-store already counted as evidence.
  maxResultSizeChars: RECALL_RESULT_CAP_CHARS,
  shouldDefer: true,
  get inputSchema(): RecallSchema {
    return recallSchema()
  },
  isEnabled() {
    return memoryVerbsEnabled()
  },
  isConcurrencySafe() {
    return true
  },
  isReadOnly() {
    return true
  },
  toAutoClassifierInput(input: z.infer<RecallSchema>) {
    return `recall ${input.query ?? input.read ?? ''}`
  },
  async description() {
    return RECALL_DESCRIPTION
  },
  async prompt() {
    return RECALL_PROMPT
  },
  async call(input: z.infer<RecallSchema>) {
    if (input.read) {
      return { data: { kind: 'record' as const, ...readMemoryRecord(input.read) } }
    }
    return {
      data: {
        kind: 'hits' as const,
        ...recallQuery(input.query ?? '', input.limit !== undefined ? { limit: input.limit } : {}),
      },
    }
  },
  mapToolResultToToolResultBlockParam(output: RecallOutput, toolUseID) {
    if (output.kind === 'record') {
      const content = output.found
        ? `${output.content ?? ''}${output.note ? `\n[${output.note}]` : ''}`
        : `not found: ${output.id}${output.note ? ` — ${output.note}` : ''}`
      return { tool_use_id: toolUseID, type: 'tool_result', content, ...(output.found ? {} : { is_error: true }) }
    }
    if (output.hits.length === 0) {
      return {
        tool_use_id: toolUseID,
        type: 'tool_result',
        content:
          'No memory matched. [elidable: this result carries no information — safe to drop from context]' +
          (output.catalog.length > 0
            ? `\nNearby topics: ${output.catalog.map(row => row.slug).join(', ')}`
            : ''),
      }
    }
    const lines = output.hits.map(
      hit => `- [${hit.id}] (${hit.label}${hit.slug !== '(recent)' ? ` · ${hit.slug}` : ''}) ${hit.preview} <${hit.signature}>`,
    )
    const catalog =
      output.catalog.length > 0
        ? `\nTopics: ${output.catalog.map(row => `${row.slug} (${row.summary.slice(0, 60)})`).join(' · ')}`
        : ''
    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content: `${output.hits.length} hit(s) — read a full record with read:"<id>" before amending it\n${lines.join('\n')}${catalog}`,
    }
  },
  renderToolUseMessage: input => renderMemoryToolUse('recall', input),
  renderToolResultMessage: renderRecallResult,
} satisfies ToolDef<RecallSchema, RecallOutput>)

// ── Reflect ────────────────────────────────────────────────────────────────

const reflectSchema = lazySchema(() =>
  z.strictObject({
    query: z.string().describe('The question to answer over memory.'),
    context: z.string().optional().describe('Extra framing for the synthesis.'),
  }),
)
type ReflectSchema = ReturnType<typeof reflectSchema>
export interface ReflectOutput {
  mode: 'synthesis' | 'recall-only'
  answer?: string
  citedIds?: string[]
  degradedReason?: string
  recall: RecallResult
}

const CITATION_RE = /\[(seq \d+|pending \d+)\]/g

export const ReflectTool = buildTool({
  name: REFLECT_TOOL_NAME,
  searchHint: 'synthesize an answer over recalled memory with citations',
  maxResultSizeChars: 40_000,
  shouldDefer: true,
  get inputSchema(): ReflectSchema {
    return reflectSchema()
  },
  isEnabled() {
    return memoryVerbsEnabled()
  },
  isConcurrencySafe() {
    return true
  },
  isReadOnly() {
    return true
  },
  toAutoClassifierInput(input: z.infer<ReflectSchema>) {
    return `reflect ${input.query}`
  },
  async description() {
    return REFLECT_DESCRIPTION
  },
  async prompt() {
    return REFLECT_PROMPT
  },
  async call(input: z.infer<ReflectSchema>, context: ToolUseContext) {
    const recall = recallQuery(input.query, { limit: 12 })
    if (recall.hits.length === 0) {
      return { data: { mode: 'recall-only' as const, degradedReason: 'nothing recalled — nothing to synthesize', recall } }
    }
    // The hit sheet the synthesis may cite: ONLY records that carry a
    // citable signature — consolidated seq entries and pending rows. A
    // recall also surfaces doc frontmatter/heading lines (`doc:<slug>:<line>`,
    // e.g. the topic's `id:`/`summary:` lines); those are structure, not
    // claim-bearing facts. Putting them on the sheet both adds noise and shows
    // the model a `[doc:…]` id the grounding check cannot accept — a synthesis
    // that grounded in one would be falsely refused. They stay in the raw
    // recall that rides along, never on the synthesis sheet.
    let pendingIndex = 0
    const citable = new Set<string>()
    const sheetLines: string[] = []
    for (const hit of recall.hits) {
      if (hit.label === 'pending') {
        pendingIndex += 1
        citable.add(`pending ${pendingIndex}`)
        sheetLines.push(`[pending ${pendingIndex}] ${hit.preview} <${hit.signature}>`)
        continue
      }
      const seqMatch = /^seq:(\d+)$/.exec(hit.id)
      if (seqMatch) {
        citable.add(`seq ${seqMatch[1]}`)
        sheetLines.push(`[seq ${seqMatch[1]}] ${hit.preview} <${hit.signature}>`)
      }
      // doc:<slug>:<line> hits are intentionally omitted from the sheet.
    }
    if (sheetLines.length === 0) {
      return {
        data: {
          mode: 'recall-only' as const,
          degradedReason: 'no citable records recalled (only topic headings matched) — here is the raw recall',
          recall,
        },
      }
    }
    const sheet = sheetLines.join('\n')
    try {
      const { oneShotCompletion } = await import('../../services/eval/evalBridge.js')
      const answer = await oneShotCompletion({
        model: context.options.mainLoopModel,
        system:
          'You synthesize an answer STRICTLY from the memory records provided. Every claim-bearing sentence cites its record like [seq 12] or [pending 1]. If the records do not answer the question, say exactly that (still citing what you checked). Never invent a record id.',
        prompt: `Question: ${input.query}${input.context ? `\nFraming: ${input.context}` : ''}\n\nMemory records:\n${sheet}`,
        signal: context.abortController.signal,
      })
      const cited = [...new Set([...answer.matchAll(CITATION_RE)].map(match => match[1]!))]
      const invented = cited.filter(id => !citable.has(id))
      if (cited.length === 0 || invented.length > 0) {
        return {
          data: {
            mode: 'recall-only' as const,
            degradedReason:
              cited.length === 0
                ? 'the synthesis cited nothing — refused (grounding is structural); here is the raw recall'
                : `the synthesis invented record id(s) ${invented.join(', ')} — refused; here is the raw recall`,
            recall,
          },
        }
      }
      return { data: { mode: 'synthesis' as const, answer, citedIds: cited, recall } }
    } catch (error) {
      return {
        data: {
          mode: 'recall-only' as const,
          degradedReason: `no synthesis: ${error instanceof Error ? error.message : String(error)}`,
          recall,
        },
      }
    }
  },
  mapToolResultToToolResultBlockParam(output: ReflectOutput, toolUseID) {
    if (output.mode === 'synthesis') {
      return {
        tool_use_id: toolUseID,
        type: 'tool_result',
        content: `${output.answer}\n\n[cited: ${output.citedIds?.join(', ')}]`,
      }
    }
    const hits = output.recall.hits
      .map(hit => `- [${hit.id}] (${hit.label}) ${hit.preview}`)
      .join('\n')
    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content: `[no synthesis — ${output.degradedReason}]\n${hits.length > 0 ? hits : '(nothing recalled; elidable)'}`,
    }
  },
  renderToolUseMessage: input => renderMemoryToolUse('reflect', input),
  renderToolResultMessage: renderReflectResult,
} satisfies ToolDef<ReflectSchema, ReflectOutput>)

// ── Correct ────────────────────────────────────────────────────────────────

const correctSchema = lazySchema(() =>
  z.strictObject({
    op: z.enum(['supersede', 'amend', 'retract']).describe('supersede = new truth; amend = fix wording (read the full record first); retract = mark wrong.'),
    id: z.string().describe('The record id (seq:<n>, from Recall).'),
    content: z.string().optional().describe('The new/corrected content (supersede/amend).'),
    replacementId: z.string().optional().describe('supersede only: an EXISTING seq:<n> already carrying the truth.'),
    reason: z.string().describe('Why — corrections always carry their reason.'),
  }),
)
type CorrectSchema = ReturnType<typeof correctSchema>
export type CorrectToolOutput = CorrectOutcome

export const CorrectTool = buildTool({
  name: CORRECT_TOOL_NAME,
  searchHint: 'correct project memory supersede amend retract',
  maxResultSizeChars: 20_000,
  shouldDefer: true,
  get inputSchema(): CorrectSchema {
    return correctSchema()
  },
  isEnabled() {
    return memoryVerbsEnabled()
  },
  isConcurrencySafe() {
    // Corrections serialize under the consolidator lock; the busy case is a
    // typed retry answer, not a race.
    return true
  },
  isReadOnly() {
    return false
  },
  toAutoClassifierInput(input: z.infer<CorrectSchema>) {
    return `${input.op} ${input.id}`
  },
  async description() {
    return CORRECT_DESCRIPTION
  },
  async prompt() {
    return CORRECT_PROMPT
  },
  async call(input: z.infer<CorrectSchema>) {
    const outcome = correctMemory({
      op: input.op,
      id: input.id,
      ...(input.content !== undefined ? { content: input.content } : {}),
      ...(input.replacementId !== undefined ? { replacementId: input.replacementId } : {}),
      reason: input.reason,
      session: safeSession(),
    })
    return { data: outcome }
  },
  mapToolResultToToolResultBlockParam(output: CorrectToolOutput, toolUseID) {
    if (output.ok) {
      return {
        tool_use_id: toolUseID,
        type: 'tool_result',
        content: `${output.op} landed: seq ${output.targetSeq} → ${output.newSeq} in topic-${output.slug}. The old record is retained under history.`,
      }
    }
    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content: `${output.op} refused (${output.code}): ${output.message}`,
      is_error: true,
    }
  },
  renderToolUseMessage: input => renderMemoryToolUse('correct', input),
  renderToolResultMessage: renderCorrectResult,
} satisfies ToolDef<CorrectSchema, CorrectToolOutput>)
