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
} from '../../constants/tools/memory.js'
import {
  renderCorrectResult,
  renderMemoryToolUse,
  renderRecallResult,
  renderReflectResult,
  renderRetainResult,
} from './UI.js'

function safeSession(): string {
  return String(getSessionId())
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
          content: z.string().describe('One durable fact; content and context together may contain at most 2000 characters.'),
          context: z.string().optional().describe('Provenance note.'),
          topic: z.string().optional().describe('Topic slug hint.'),
          pin: z.boolean().optional().describe("Pin the user's exact words as an always-loaded standing rule or preference, when they asked for that lasting rule."),
          replaces: z.string().optional().describe('Prior rule id (seq:<n>) the user explicitly replaced; keeps the old wording as history. For a user-requested rule, the user answers a yes/no card first (under sovereign, no card).'),
        }),
      )
      .min(1)
      .max(20),
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

export const RetainTool: Unbuilt = unbuilt('src/tools/MemoryTools/MemoryTools.ts:98')


const recallSchema = lazySchema(() =>
  z
    .strictObject({
      query: z.string().optional().describe('Search pages, archive, pending rows and lineage (phrases/regex match literally, else words). A pointer is an id, a title and footnotes: open one with read to see the record.'),
      read: z.string().optional().describe('Read record by id: seq:<n>, doc:<slug>, pending:<ts>, or ledger:<ordinal> (session + handoff).'),
      limit: z.number().int().min(1).max(POINTER_LIMIT).optional().describe(`Max pointers (default ${POINTER_DEFAULT_LIMIT}).`),
    })
    .refine(value => Boolean(value.query) !== Boolean(value.read), {
      message: 'pass exactly one of query or read',
    }),
)
type RecallSchema = ReturnType<typeof recallSchema>
export type RecallOutput =
  | ({ kind: 'pointers'; ranking?: string } & PointerResult)
  | ({ kind: 'record' } & MemoryReadResult)

export const RecallTool: Unbuilt = unbuilt('src/tools/MemoryTools/MemoryTools.ts:210')


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
import { unbuilt, type Unbuilt } from '../../pi/holes.js'

export const ReflectTool: Unbuilt = unbuilt('src/tools/MemoryTools/MemoryTools.ts:297')


const correctSchema = lazySchema(() =>
  z.strictObject({
    op: z.enum(['supersede', 'amend', 'retract']).describe('supersede = new truth; amend = fix wording (needs full record read this session); retract = mark wrong.'),
    id: z.string().describe('Record id: seq:<n> (consolidated) or pending:<ts> (draft).'),
    content: z.string().optional().describe('New/corrected text (supersede, amend).'),
    replacementId: z.string().optional().describe('supersede: existing seq:<n> instead of content.'),
    reason: z.string().describe('Reason for correction.'),
  }),
)
type CorrectSchema = ReturnType<typeof correctSchema>
export type CorrectToolOutput = CorrectOutcome

export const CorrectTool: Unbuilt = unbuilt('src/tools/MemoryTools/MemoryTools.ts:420')
