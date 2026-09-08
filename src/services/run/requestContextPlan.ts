
import type { DeadThinkingMark } from '../../types/message.js'
import { createHash } from 'node:crypto'
import type { QuerySource } from '../../constants/querySource.js'
import {
  microcompactMessages,
  projectTimeBasedMicrocompact,
} from '../compact/microCompact.js'
import type { Message } from '../../types/message.js'
import { getMessagesAfterCompactBoundary } from '../../utils/messages.js'
import { projectRewoundWindows } from '../compact/checkpointRewind.js'
import { PROTECTED_TOOL_NAMES } from '../compact/pruneProtections.js'
import {
  applyToolResultBudget,
  cloneContentReplacementState,
  type ContentReplacementState,
  type ToolResultReplacementRecord,
} from '../../utils/toolResultStorage.js'
import {
  calibrationFor,
  type CalibrationRead,
  estimateTokensFromChars,
  noteMeasuredUsage,
} from './contextCalibration.js'
import { getContextEpoch, recordAppliedPlan } from './contextEpochs.js'
import {
  candidateIndexFor,
  type ContextPolicyClass,
  type ContextSelectionPlan,
  resolveSelectionBudget,
  resolveSelectionPolicy,
  runSelectionStage,
  type SelectionBudget,
} from './contextSelection.js'
import type { OwnerKey } from './ownerKey.js'
import { registerOwnerScopedStore } from './ownerLifecycle.js'
import { OwnerScopedStore } from './ownerScopedStore.js'

export interface RequestContextPlanInput {
  messages: Message[]
  owner: OwnerKey
  querySource: QuerySource
  contentReplacementState: ContentReplacementState | undefined
  persistReplacements?: (records: ToolResultReplacementRecord[]) => void | Promise<void>
  skipToolNames: ReadonlySet<string>
  microcompact?: typeof microcompactMessages
  readFileState?: Pick<import('../../utils/fileStateCache.js').FileStateCache, 'delete'>
  selectionBudget?: SelectionBudget | null
  calibrationKey?: string | null
  harnessContextPolicy?: ContextPolicyClass | null
  pressurePrune?: true
}

export interface RequestContextPlan {
  planVersion: 2
  mode: 'apply' | 'inspect'
  owner: OwnerKey
  epoch: number
  sourceMessageCount: number
  afterBoundaryCount: number
  messages: Message[]
  reductions: {
    toolResultBudgetReplacements: number
    timeBasedCleared: number
    pressurePruned?: { cleared: number; tokensSaved: number }
    deadThinkingMarks?: DeadThinkingMark[]
    reasons: string[]
  }
  digest: string
  builtAt: number
  unknownFields: string[]
  selection: ContextSelectionPlan
  tokenEstimate: {
    key: string
    estimatedTokens: number
    calibration: CalibrationRead
  } | null
}

function digestAndCharsOfMessages(messages: Message[]): { digest: string; chars: number } {
  const h = createHash('sha256')
  let chars = 0
  for (const m of messages) {
    const type = (m as { type?: string }).type ?? '?'
    const content = (m as { message?: { content?: unknown } }).message?.content
    const serialized = JSON.stringify(content ?? null)
    h.update(type)
    h.update('\u0000')
    h.update(serialized ?? 'null')
    chars += typeof content === 'string' ? content.length : (serialized?.length ?? 0)
    h.update('\u0001')
  }
  return { digest: h.digest('hex'), chars }
}

export function digestOfMessages(messages: Message[]): string {
  return digestAndCharsOfMessages(messages).digest
}

function placeholdersOf(view: Message[], ids: ReadonlySet<string>): Map<string, string> {
  const out = new Map<string, string>()
  for (const message of view) {
    if (message.type !== 'user') continue
    const content = (message as { message?: { content?: unknown } }).message?.content
    if (!Array.isArray(content)) continue
    for (const block of content as Array<{ type?: string; tool_use_id?: string; content?: unknown }>) {
      if (
        block.type === 'tool_result' &&
        typeof block.tool_use_id === 'string' &&
        ids.has(block.tool_use_id) &&
        typeof block.content === 'string'
      ) {
        out.set(block.tool_use_id, block.content)
      }
    }
  }
  return out
}

const lastAppliedPlans = new OwnerScopedStore<{ plan: RequestContextPlan | null }>({
  name: 'request-plans',
  create: () => ({ plan: null }),
})
registerOwnerScopedStore(lastAppliedPlans)

export function getLastAppliedPlan(owner: OwnerKey): RequestContextPlan | null {
  return lastAppliedPlans.peek(owner)?.plan ?? null
}

export function reconcileAppliedPlanUsage(owner: OwnerKey, measuredTokens: number): void {
  const est = lastAppliedPlans.peek(owner)?.plan?.tokenEstimate
  if (!est) return
  noteMeasuredUsage(est.key, est.estimatedTokens, measuredTokens)
}

export async function buildRequestContextPlan(
  input: RequestContextPlanInput,
  mode: 'apply' | 'inspect',
): Promise<RequestContextPlan> {
  const unknownFields: string[] = []
  const reasons: string[] = []
  const sourceMessageCount = input.messages.length
  const afterBoundary = getMessagesAfterCompactBoundary(input.messages)
  const afterRewinds = projectRewoundWindows(afterBoundary)
  if (afterRewinds.length < afterBoundary.length) {
    reasons.push(
      `rewind projection excluded ${afterBoundary.length - afterRewinds.length} abandoned-exploration message(s)`,
    )
  }
  let view = [...afterRewinds]
  const afterBoundaryCount = view.length

  const policy = resolveSelectionPolicy(input.harnessContextPolicy ?? null)
  const selectionIndex = candidateIndexFor(input.owner, mode)
  const budgetResolution = resolveSelectionBudget(input.selectionBudget)
  const budget = budgetResolution.budget
  if (budgetResolution.note) unknownFields.push(budgetResolution.note)
  if (policy === 'bounded-optional' && !budget) {
    unknownFields.push('selection budget absent — bounded-optional excludes nothing')
  }
  const staged = runSelectionStage(view, policy, selectionIndex, budget)
  view = staged.view
  const selection = staged.selection
  if (selection.excluded.length > 0) {
    reasons.push(
      `context selection excluded ${selection.excluded.length} optional item(s) (required closure ${selection.requiredCount} retained${budgetResolution.source === 'flag' ? '; budget: MERCURY_SELECTION_BUDGET' : ''})`,
    )
  }

  let budgetReplacements = 0
  if (input.contentReplacementState) {
    const state =
      mode === 'apply'
        ? input.contentReplacementState
        : cloneContentReplacementState(input.contentReplacementState)
    const seenBefore = state.seenIds.size
    view = await applyToolResultBudget(
      view,
      state,
      mode === 'apply' ? input.persistReplacements : undefined,
      new Set([...(input.skipToolNames ?? []), ...PROTECTED_TOOL_NAMES]),
    )
    budgetReplacements = state.seenIds.size - seenBefore
    if (budgetReplacements > 0) {
      reasons.push(`tool-result budget replaced ${budgetReplacements} oversized result(s)`)
    }
  } else {
    unknownFields.push('contentReplacementState absent — no budget transform in this lane')
  }

  let timeBasedCleared = 0
  let pressurePruned: RequestContextPlan['reductions']['pressurePruned']
  let deadThinkingMarks: RequestContextPlan['reductions']['deadThinkingMarks']
  {
    const projected = projectTimeBasedMicrocompact(view, input.querySource)
    if (projected) {
      timeBasedCleared = projected.cleared
      reasons.push(
        `time-based microcompact cleared ${projected.cleared} stale tool result(s) (~${projected.tokensSaved} tokens)`,
      )
    }
    if (mode === 'apply') {
      const micro = input.microcompact ?? microcompactMessages
      const result = await micro(
        view,
        undefined,
        input.querySource,
        input.readFileState ? { readFileState: input.readFileState } : undefined,
        input.pressurePrune === true ? { pressure: true } : undefined,
      )
      view = result.messages
      if (result.deadMarks !== undefined && result.deadMarks.length > 0) deadThinkingMarks = result.deadMarks
      if (result.pruned !== undefined && result.pruned.cleared > 0) {
        if (input.pressurePrune === true) {
          pressurePruned = { cleared: result.pruned.cleared, tokensSaved: result.pruned.tokensSaved }
          reasons.push(
            `pressure prune (context overflow) cleared ${result.pruned.cleared} superseded tool result(s) (~${result.pruned.tokensSaved} tokens)`,
          )
        }
        if (input.contentReplacementState) {
          const placeholderById = placeholdersOf(view, new Set(result.pruned.clearedIds))
          const records: ToolResultReplacementRecord[] = []
          for (const [toolUseId, replacement] of placeholderById) {
            if (input.contentReplacementState.replacements.get(toolUseId) === replacement) continue
            input.contentReplacementState.seenIds.add(toolUseId)
            input.contentReplacementState.replacements.set(toolUseId, replacement)
            records.push({ kind: 'tool-result', toolUseId, replacement })
          }
          if (records.length > 0) await input.persistReplacements?.(records)
        } else {
          unknownFields.push('contentReplacementState absent — cleared results hold for this request only')
        }
      }
    } else if (projected) {
      view = projected.messages
    }
  }

  const { digest, chars } = digestAndCharsOfMessages(view)
  let tokenEstimate: RequestContextPlan['tokenEstimate'] = null
  if (input.calibrationKey) {
    const calibration = calibrationFor(input.calibrationKey)
    tokenEstimate = {
      key: input.calibrationKey,
      estimatedTokens: estimateTokensFromChars(chars, calibration),
      calibration,
    }
  }
  const plan: RequestContextPlan = {
    planVersion: 2,
    mode,
    owner: input.owner,
    epoch: getContextEpoch(input.owner).epoch,
    sourceMessageCount,
    afterBoundaryCount,
    messages: view,
    reductions: {
      ...(deadThinkingMarks !== undefined ? { deadThinkingMarks } : {}),
      toolResultBudgetReplacements: budgetReplacements,
      timeBasedCleared,
      ...(pressurePruned !== undefined ? { pressurePruned } : {}),
      reasons,
    },
    digest,
    builtAt: Date.now(),
    unknownFields,
    selection,
    tokenEstimate,
  }
  if (mode === 'apply') {
    lastAppliedPlans.get(input.owner).plan = plan
    recordAppliedPlan(input.owner, digest)
  }
  return plan
}
