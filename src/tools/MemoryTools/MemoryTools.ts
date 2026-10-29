import { z } from 'zod/v4'
import { buildTool, type ToolDef, type ToolUseContext } from '../../Tool.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { getSessionId } from '../../bootstrap/state.js'
import {
  consolidatedIdOf,
  correctionPreflight,
  correctMemoryJudged,
  memoryVerbsEnabled,
  readMemoryRecord,
  RECALL_RESULT_CAP_CHARS,
  recallQuery,
  retainItemsJudged,
  type CorrectOutcome,
  type MemoryReadResult,
  type RecallResult,
  type RetainItemOutcome,
  type RuleAuthority,
} from '../../mneme/memoryVerbs.js'
import { mnemeLibraryDir } from '../../mneme/mnemeGates.js'
import { CREWMATE_CORRECT_REFUSAL, correctAskRefusal, latestPinIntent, memoryAskRefusal } from '../../mneme/memoryPinIntent.js'
import { gradeLines, MEMORY_EVIDENCE_CONTRACT, recordGrade } from '../../mneme/memoryEvidence.js'
import { askedReplacements, askedRuleOf, askRuleCard, correctionChange, ruleCardAsk, ruleCardText } from './ruleCard.js'
import { confirmCitedFacts, renderFootnotes } from '../../mneme/mnemeFootnotes.js'
import { POINTER_DEFAULT_LIMIT, POINTER_LIMIT, limitCutLine, renderPointerLine, searchPointers, type PointerResult } from '../../mneme/mnemePointers.js'
import { runDueMaintenance } from '../../mneme/mnemeMaintenance.js'
import { recallRankingWords } from '../../mneme/mnemeIndex.js'
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

function abortOf(context: Partial<ToolUseContext>): { signal?: AbortSignal } {
  const signal = context.abortController?.signal
  return signal === undefined ? {} : { signal }
}

const retainSchema = lazySchema(() =>
  z.strictObject({
    items: z
      .array(
        z.strictObject({
          content: z.string().describe('One self-contained durable fact.'),
          context: z.string().optional().describe('Where the fact came from (provenance note).'),
          topic: z.string().optional().describe('Topic routing hint (slugified).'),
          pin: z.boolean().optional().describe("Only when the user asked to remember this as a standing rule or preference: pins it, in their words, marked as asked for by the user. A pin needs the user's own words in the main chat — the rule in their latest message, or their 'yes, pin it' after stating it; otherwise it is refused and nothing is stored. A crewmate cannot pin: retain the fact without pin."),
          replaces: z.string().optional().describe('Only when the user said this rule replaces an earlier one: that rule as seq:<n> — from the pinned shelf, or the rule the user unpinned in /memory and now restates. The new rule takes its place and the old one becomes history, so one rule stays current. For a rule marked asked for by the user, the user answers a yes/no card first (under sovereign, no card).'),
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
  shelf?: { landed: boolean; reason: string }
}

function pinnedItemStored(items: Array<{ pin?: boolean; replaces?: string }>, outcomes: RetainItemOutcome[]): boolean {
  return outcomes.some(outcome => {
    const item = items[outcome.index]
    return outcome.status === 'stored' && outcome.replaced === undefined && (item?.pin === true || (item?.replaces ?? '').trim() !== '')
  })
}

function ruleAnswerWords(via: RuleAuthority | undefined, verb: string, history: boolean): string {
  if (via === 'card') return ` The user said yes on the card: the rule they asked Mercury to remember was ${verb} from the chat.`
  if (via === 'sovereign') return ` Under sovereign no card was asked: the rule the user asked Mercury to remember was ${verb} from the chat under sovereign${history ? ", and /memory's history says so" : ''}.`
  return ''
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

    return false
  },
  isReadOnly() {
    return false
  },
  async description() {
    return RETAIN_DESCRIPTION
  },
  async prompt() {
    return RETAIN_PROMPT
  },
  async checkPermissions(input: z.infer<RetainSchema>, context: ToolUseContext) {
    if (memoryAskRefusal(context.messages ?? [], context.agentId ? String(context.agentId) : undefined) !== null) return { behavior: 'allow' as const, updatedInput: input }
    return ruleCardAsk(context) ?? { behavior: 'allow' as const, updatedInput: input }
  },
  async call(input: z.infer<RetainSchema>, context: ToolUseContext, canUseTool, parentMessage) {
    const unasked = memoryAskRefusal(context.messages ?? [], context.agentId ? String(context.agentId) : undefined)
    if (unasked !== null) {
      const outcomes: RetainItemOutcome[] = input.items.map((_, index) => ({ index, status: 'refused', reason: unasked }))
      return { data: { outcomes, stored: 0, refused: outcomes.length } }
    }
    const asked = askedReplacements(input.items, mnemeLibraryDir())
    const verdict =
      asked.length === 0
        ? null
        : await askRuleCard({
            tool: RetainTool,
            toolInput: input,
            card: ruleCardText(RETAIN_TOOL_NAME, asked.map(a => a.change)),
            rules: asked.map(a => a.change.rule),
            context,
            canUseTool,
            parentMessage,
          })
    const outcomes = await retainItemsJudged(
      input.items,
      {
        session: safeSession(),
        pinIntent: latestPinIntent(context.messages ?? [], context.agentId ? String(context.agentId) : undefined),
        ...(context.agentId ? { agent: String(context.agentId) } : {}),
        ...(verdict?.ok === true ? { authority: verdict.via } : {}),
      },
      abortOf(context),
    )
    if (verdict !== null && !verdict.ok) {
      for (const { index } of asked) {
        const outcome = outcomes[index]
        if (outcome?.status === 'refused') outcome.reason = verdict.message
      }
    }
    const stored = outcomes.filter(o => o.status === 'stored').length
    const refused = outcomes.filter(o => o.status === 'refused').length
    if (!pinnedItemStored(input.items, outcomes)) return { data: { outcomes, stored, refused } }
    const landed = await runDueMaintenance('retain')
    return { data: { outcomes, stored, refused, shelf: { landed: landed.consolidated === true, reason: landed.reason } } }
  },
  mapToolResultToToolResultBlockParam(output: RetainOutput, toolUseID) {
    const lines = output.outcomes.map(outcome =>
      outcome.status === 'refused'
        ? `- item ${outcome.index}: REFUSED — ${outcome.reason} (the fact was NOT stored)`
        : outcome.status === 'stored' && outcome.replaced !== undefined
          ? `- item ${outcome.index}: stored → ${outcome.id}, in place of seq ${outcome.replaced.seq}; the old wording is kept in history and the pin follows the new one.${ruleAnswerWords(outcome.replaced.via, 'replaced', true)}`
          : `- item ${outcome.index}: ${outcome.status} → ${outcome.id}`,
    )
    if (output.shelf) {
      lines.push(
        output.shelf.landed
          ? '- the pinned rule is on the shelf now and loads into every session from the next chat on'
          : `- the pinned rule lands on the shelf at the next maintenance pass (${output.shelf.reason})`,
      )
    }
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

const recallSchema = lazySchema(() =>
  z
    .strictObject({
      query: z.string().optional().describe('Search memory for pointers: facts and pinned rulings in the pages, archive and pending observations, and the sessions and handoffs of the lineage ledger. A phrase or regex matches literally; otherwise the words of the query are matched. A pointer is an id, a title and footnotes: open one with read to see the record.'),
      read: z.string().optional().describe('Read one full record by id: seq:<n> (a fact or ruling) · doc:<slug> (a whole page) · pending:<ts> · ledger:<ordinal> (a session\'s entry and its handoff).'),
      limit: z.number().int().min(1).max(POINTER_LIMIT).optional().describe(`Max pointers (default ${POINTER_DEFAULT_LIMIT}, at most ${POINTER_LIMIT}).`),
    })
    .refine(value => Boolean(value.query) !== Boolean(value.read), {
      message: 'pass exactly one of query or read',
    }),
)
type RecallSchema = ReturnType<typeof recallSchema>
export type RecallOutput =
  | ({ kind: 'pointers'; ranking?: string } & PointerResult)
  | ({ kind: 'record' } & MemoryReadResult)

export const RecallTool = buildTool({
  name: RECALL_TOOL_NAME,
  searchHint: 'search project memory with stable ids and provenance',

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
        kind: 'pointers' as const,
        ...searchPointers(input.query ?? '', input.limit !== undefined ? { limit: input.limit } : {}),
        ranking: recallRankingWords(),
      },
    }
  },
  mapToolResultToToolResultBlockParam(output: RecallOutput, toolUseID) {
    if (output.kind === 'record') {
      const footnotes = output.footnotes ? renderFootnotes(output.footnotes) : ''
      const content = output.found
        ? `${output.renderedContent ?? output.content ?? ''}${output.note ? `\n[${output.note}]` : ''}${footnotes ? `\n[footnotes: ${footnotes}]` : ''}`
        : `not found: ${output.id}${output.note ? ` — ${output.note}` : ''}`
      return { tool_use_id: toolUseID, type: 'tool_result', content, ...(output.found ? {} : { is_error: true }) }
    }
    if (output.pointers.length === 0) {
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
    const catalog =
      output.catalog.length > 0
        ? `\nTopics: ${output.catalog.map(row => `${row.slug} (${row.summary.slice(0, 60)})`).join(' · ')}`
        : ''
    const cut = limitCutLine(output)
    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content: `${output.pointers.length} pointer(s) — a pointer carries no content: open one with read:"<id>" before you rely on it\n${output.ranking ? `ranked by ${output.ranking}\n` : ''}${cut === null ? '' : `${cut}\n`}${output.pointers.map(renderPointerLine).join('\n')}${catalog}`,
    }
  },
  renderToolUseMessage: input => renderMemoryToolUse('recall', input),
  renderToolResultMessage: renderRecallResult,
} satisfies ToolDef<RecallSchema, RecallOutput>)

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

import { synthesisCitations } from '../../mneme/memoryCitations.js'

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

    let pendingIndex = 0
    const citable = new Set<string>()
    const sheetLines: string[] = []
    for (const hit of recall.hits) {
      if (hit.label === 'pending') {
        pendingIndex += 1
        citable.add(`pending ${pendingIndex}`)
        sheetLines.push(`[pending ${pendingIndex}] ${recordGrade(hit.id, hit.signature)} ${hit.preview} <${hit.signature}>`)
        continue
      }
      const seqMatch = /^seq:(\d+)$/.exec(hit.id)
      if (seqMatch) {
        citable.add(`seq ${seqMatch[1]}`)
        sheetLines.push(`[seq ${seqMatch[1]}] ${recordGrade(hit.id, hit.signature)} ${hit.preview} <${hit.signature}>`)
      }
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
        model: context.options.engineModel,
        system:
          'You synthesize an answer STRICTLY from the memory records provided. Every claim-bearing sentence cites its record like [seq 12] or [pending 1]. If the records do not answer the question, say exactly that (still citing what you checked). Never invent a record id. ' + MEMORY_EVIDENCE_CONTRACT,
        prompt: `Question: ${input.query}${input.context ? `\nFraming: ${input.context}` : ''}\n\nMemory records:\n${sheet}`,
        signal: context.abortController.signal,
      })
      const cited = synthesisCitations(answer)
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
      confirmCitedFacts(answer)
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
        content: `${gradeLines(output.answer ?? '', '[memory synthesis · unverified]')}\n\n[cited: ${output.citedIds?.join(', ')}]`,
      }
    }
    const hits = output.recall.hits
      .map(hit => `- [${hit.id}] ${recordGrade(hit.id, hit.signature)} (${hit.label}) ${hit.preview}`)
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

const correctSchema = lazySchema(() =>
  z.strictObject({
    op: z.enum(['supersede', 'amend', 'retract']).describe('supersede = new truth; amend = fix wording (read the full record first); retract = mark wrong (a consolidated row keeps its history; a pending row is a draft and is struck).'),
    id: z.string().describe('The record id from Recall: seq:<n> for a consolidated row, pending:<ts> for a draft still in the buffer.'),
    content: z.string().optional().describe('The new/corrected content (supersede/amend).'),
    replacementId: z.string().optional().describe('supersede only: an existing seq:<n> already carrying the truth.'),
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

    return false
  },
  isReadOnly() {
    return false
  },
  async description() {
    return CORRECT_DESCRIPTION
  },
  async prompt() {
    return CORRECT_PROMPT
  },
  async checkPermissions(input: z.infer<CorrectSchema>, context: ToolUseContext) {
    return ruleCardAsk(context) ?? { behavior: 'allow' as const, updatedInput: input }
  },
  async call(input: z.infer<CorrectSchema>, context: ToolUseContext, canUseTool, parentMessage) {
    if (context.agentId) return { data: { ok: false as const, op: input.op, code: 'crewmate', message: CREWMATE_CORRECT_REFUSAL } }
    const dir = mnemeLibraryDir()
    const consolidated = consolidatedIdOf(input.id, dir)
    const id = consolidated ?? input.id
    const followed = consolidated === null ? {} : { followed: `${input.id} had consolidated as ${consolidated}; the correction followed it` }
    const correction = {
      op: input.op,
      id,
      ...(input.content !== undefined ? { content: input.content } : {}),
      ...(input.replacementId !== undefined ? { replacementId: input.replacementId } : {}),
      reason: input.reason,
      session: safeSession(),
    }
    const rule = askedRuleOf(id, dir)
    if (rule === null) {
      const unasked = correctAskRefusal(context.messages ?? [])
      if (unasked !== null) return { data: { ok: false as const, op: input.op, code: 'not-asked', message: unasked, ...followed } }
      return { data: { ...(await correctMemoryJudged(correction, abortOf(context))), ...followed } }
    }
    const early = correctionPreflight(correction, dir)
    if (early !== null) return { data: { ...early, ...followed } }
    const verdict = await askRuleCard({
      tool: CorrectTool,
      toolInput: { ...input, id },
      card: ruleCardText(CORRECT_TOOL_NAME, [{ rule, change: correctionChange({ ...input, id }, dir) }], input.reason),
      rules: [rule],
      context,
      canUseTool,
      parentMessage,
    })
    if (!verdict.ok) return { data: { ok: false as const, op: input.op, code: verdict.code, message: verdict.message, ...followed } }
    return { data: { ...(await correctMemoryJudged({ ...correction, authority: verdict.via }, abortOf(context))), ...followed } }
  },
  mapToolResultToToolResultBlockParam(output: CorrectToolOutput, toolUseID) {
    const verb = output.op === 'retract' ? 'unpinned and struck' : 'corrected'
    const followed = output.followed === undefined ? '' : ` (${output.followed})`
    if (!output.ok && output.code === 'user-kept-rule') {
      return { tool_use_id: toolUseID, type: 'tool_result', content: `${output.message}${followed}` }
    }
    if (!output.ok && (output.code === 'not-asked' || output.code === 'crewmate')) {
      return { tool_use_id: toolUseID, type: 'tool_result', content: output.message, is_error: true }
    }
    if (output.ok && 'draft' in output) {
      const tail =
        output.newId !== null
          ? `the draft was replaced by ${output.newId}, which keeps the old draft's words as its history (read it with Recall read:"${output.newId}") until consolidation files the fact`
          : output.replacedBy !== undefined
            ? `the draft was struck and seq ${output.replacedBy} carries the truth; a draft that is struck is gone, it leaves no history and its bytes are gone from the buffer`
            : 'the draft was struck; a draft that is struck is gone, it leaves no history and its bytes are gone from the buffer'
      return {
        tool_use_id: toolUseID,
        type: 'tool_result',
        content: `${output.op} landed on the pending row ${output.targetId}: ${tail}.${ruleAnswerWords(output.via, verb, false)}`,
      }
    }
    if (output.ok) {
      return {
        tool_use_id: toolUseID,
        type: 'tool_result',
        content: `${output.op} landed: seq ${output.targetSeq} → ${output.newSeq} in topic-${output.slug}. The old record is retained under history.${ruleAnswerWords(output.via, verb, true)}${followed}`,
      }
    }
    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content: `${output.op} refused (${output.code}): ${output.message}${followed}`,
      is_error: true,
    }
  },
  renderToolUseMessage: input => renderMemoryToolUse('correct', input),
  renderToolResultMessage: renderCorrectResult,
} satisfies ToolDef<CorrectSchema, CorrectToolOutput>)
