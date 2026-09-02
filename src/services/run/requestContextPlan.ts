// ============================================================================
//  requestContextPlan — ONE request-context projection for the outgoing API
//  request AND /context.
//
//  The live query path and /context must not reimplement "what the model
//  sees" separately (a split /context skips the tool-result budget and
//  runs microcompact without the querySource, so the time-based content-clear
//  it performs on the real request is invisible). This module is the single
//  builder:
//
//    · apply mode   — performs the REAL stateful transition exactly once for
//                     the outgoing request (records new content replacements,
//                     fires the time-based side effects, caches the plan +
//                     digest by owner);
//    · inspect mode — the SAME projected view/digest with ZERO side effects
//                     (cloned replacement state, the pure time-based
//                     projection, nothing consumed, no epoch advanced).
//
//  The digest is a stable sha256 over the projected message content — the
//  parity oracle compares apply vs inspect for identical inputs.
// ============================================================================

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
  /** apply mode only: persist newly-recorded replacements (query.ts wiring). */
  persistReplacements?: (records: ToolResultReplacementRecord[]) => void
  /** Tools exempt from the result budget (no finite maxResultSizeChars). */
  skipToolNames: ReadonlySet<string>
  /** apply mode: the microcompact implementation (query.ts threads its
   *  QueryDeps seam so tests can inject fakes). Default: the real one. */
  microcompact?: typeof microcompactMessages
  /** apply mode only: the read-dedup ledger (ToolUseContext.readFileState).
   *  A time-based clear of a FileReadTool result invalidates its entry so
   *  the dedup stub can never vouch for content the clear just removed
   *  from the model's view. Inspection never threads it (zero side
   *  effects). */
  readFileState?: Pick<import('../../utils/fileStateCache.js').FileStateCache, 'delete'>
  /** Selection stage: the explicit optional-item budget. Absent ⇒
   *  bounded-optional excludes nothing (honest no-budget state). */
  selectionBudget?: SelectionBudget | null
  /** The provider/model/codec-epoch calibration key for this
   *  request (calibrationKeyFor at the caller — the plan stays
   *  provider-neutral). Absent ⇒ no token estimate on the plan. */
  calibrationKey?: string | null
  /** The armed harness profile's selection-policy REQUEST
   *  (harnessContextPolicyRequest at the caller — the live request and
   *  /context thread it identically for parity). The explicit
   *  MERCURY_CONTEXT_SELECTION flag outranks it; absent/null ⇒ the flag or
   *  the preserve-all default. */
  harnessContextPolicy?: ContextPolicyClass | null
  /** apply mode only: the overflow recovery ladder's PRUNE rung — run the
   *  clearing walk under the pressure trigger and register every cleared
   *  result as a content replacement (the same ledger the tool-result
   *  budget writes, persisted through the same callback), so the prune
   *  holds on every later request and across a resume. */
  pressurePrune?: true
}

export interface RequestContextPlan {
  /** Versioned shape growth: 2 = the selection stage joined. */
  planVersion: 2
  mode: 'apply' | 'inspect'
  owner: OwnerKey
  epoch: number
  /** Message count before/after the boundary filter. */
  sourceMessageCount: number
  afterBoundaryCount: number
  /** The transformed view actually sent (apply) / would be sent (inspect). */
  messages: Message[]
  /** Reductions applied, with reasons — honest accounting. */
  reductions: {
    toolResultBudgetReplacements: number
    timeBasedCleared: number
    /** The pressure prune's receipt (apply mode, pressurePrune requested);
     *  absent when the walk found nothing to clear. */
    pressurePruned?: { cleared: number; tokensSaved: number }
    reasons: string[]
  }
  /** Stable digest over the projected view (parity tests key on this). */
  digest: string
  builtAt: number
  /** Facts unavailable in this mode (explicit, never guessed). */
  unknownFields: string[]
  /** The selection stage record: policy, closure counts,
   *  exclusions with spans/pointers, index accounting, decision digest. */
  selection: ContextSelectionPlan
  /** Token estimation for the projected view: epoch-keyed, with the
   *  calibration read TYPED (absence explicit, never a cross-epoch leak).
   *  null when the caller supplied no calibration key. */
  tokenEstimate: {
    key: string
    estimatedTokens: number
    calibration: CalibrationRead
  } | null
}

/** Stable, content-only serialization for the digest (uuids/timestamps of
 *  the CARRIER are identity, not content — excluded so a re-read of the same
 *  view digests identically), FUSED with the character total the token
 *  estimator reads: each content serializes ONCE and feeds both consumers.
 *  Byte-compatible with the previously-split walks — the digest hashes the
 *  QUOTED serialization while a string content still counts its RAW length
 *  for the estimate, exactly the numbers the two separate passes produced. */
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

/** The digest alone (the parity oracle's entry point). */
export function digestOfMessages(messages: Message[]): string {
  return digestAndCharsOfMessages(messages).digest
}

/** The placeholder string each cleared tool result now wears in the
 *  projected view, by tool-use id — exactly the bytes the ledger must
 *  re-apply (stored, never re-derived: the digest label carries counts the
 *  cleared content can no longer supply). */
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

/** The most recent APPLIED plan for an owner (UI/doctor drill-down). */
export function getLastAppliedPlan(owner: OwnerKey): RequestContextPlan | null {
  return lastAppliedPlans.peek(owner)?.plan ?? null
}

/** Settlement reconciliation: fold one settled call's measured
 *  input tokens against the estimate the applied plan carried. The turn
 *  machine calls this for the FIRST call of a turn — the one whose request
 *  is the plan's projected view. No-op without an applied plan estimate. */
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
  // Rewound-exploration windows leave every provider-bound view FIRST
  // (spec 07-C4): the transcript keeps them, the request never carries
  // them. Identity-returns when no rewind record exists.
  const afterBoundary = getMessagesAfterCompactBoundary(input.messages)
  const afterRewinds = projectRewoundWindows(afterBoundary)
  if (afterRewinds.length < afterBoundary.length) {
    reasons.push(
      `rewind projection excluded ${afterBoundary.length - afterRewinds.length} abandoned-exploration message(s)`,
    )
  }
  let view = [...afterRewinds]
  const afterBoundaryCount = view.length

  // 0. SELECTION — required closure first, ahead of the reducers.
  //    preserve-all (the default policy) projects the view unchanged; the
  //    plan still carries honest candidate/index accounting. Inspect works
  //    on a CLONED index so inspection never moves the watermark (parity
  //    with zero side effects — the same law as the replacement state).
  const policy = resolveSelectionPolicy(input.harnessContextPolicy ?? null)
  const selectionIndex = candidateIndexFor(input.owner, mode)
  // The budget-publishing owner: the flag outranks a caller
  // budget, mirroring the policy resolver; unset ⇒ caller ⇒ null (the
  // byte-identical accepted default).
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

  // 1. Aggregate tool-result budget. Inspect clones the replacement state so
  //    inspection can never consume a decision the real request would make.
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
      // The named protection law joins the caller's skip set: protected
      // classes are never budget-replaced, whoever built the input.
      new Set([...(input.skipToolNames ?? []), ...PROTECTED_TOOL_NAMES]),
    )
    budgetReplacements = state.seenIds.size - seenBefore
    if (budgetReplacements > 0) {
      reasons.push(`tool-result budget replaced ${budgetReplacements} oversized result(s)`)
    }
  } else {
    unknownFields.push('contentReplacementState absent — no budget transform in this lane')
  }

  // 2. Microcompact. Apply = the real path (side effects included);
  //    inspect = the PURE time-based projection (identical view, zero state).
  let timeBasedCleared = 0
  let pressurePruned: RequestContextPlan['reductions']['pressurePruned']
  {
    // Counts come from the PURE projection in both modes (identical math).
    const projected = projectTimeBasedMicrocompact(view, input.querySource)
    if (projected) {
      timeBasedCleared = projected.cleared
      reasons.push(
        `time-based microcompact cleared ${projected.cleared} stale tool result(s) (~${projected.tokensSaved} tokens)`,
      )
    }
    if (mode === 'apply') {
      // The REAL transform (fires the apply-time side effects exactly once —
      // read-dedup invalidation for cleared FileReadTool results included).
      const micro = input.microcompact ?? microcompactMessages
      const result = await micro(
        view,
        undefined,
        input.querySource,
        input.readFileState ? { readFileState: input.readFileState } : undefined,
        input.pressurePrune === true ? { pressure: true } : undefined,
      )
      view = result.messages
      // The pressure prune's persistence: every cleared result joins the
      // replacement ledger with the placeholder it now wears — the budget
      // stage re-applies ledger entries by lookup on every later request,
      // and the persisted records rebuild the ledger on resume (the same
      // road the oversized-result replacements ride; no second store).
      if (input.pressurePrune === true && result.pruned !== undefined && result.pruned.cleared > 0) {
        pressurePruned = { cleared: result.pruned.cleared, tokensSaved: result.pruned.tokensSaved }
        reasons.push(
          `pressure prune (context overflow) cleared ${result.pruned.cleared} superseded tool result(s) (~${result.pruned.tokensSaved} tokens)`,
        )
        if (input.contentReplacementState) {
          const placeholderById = placeholdersOf(view, new Set(result.pruned.clearedIds))
          const records: ToolResultReplacementRecord[] = []
          for (const [toolUseId, replacement] of placeholderById) {
            if (input.contentReplacementState.replacements.get(toolUseId) === replacement) continue
            input.contentReplacementState.seenIds.add(toolUseId)
            input.contentReplacementState.replacements.set(toolUseId, replacement)
            records.push({ kind: 'tool-result', toolUseId, replacement })
          }
          if (records.length > 0) input.persistReplacements?.(records)
        } else {
          unknownFields.push('contentReplacementState absent — the pressure prune holds for this request only')
        }
      }
    } else if (projected) {
      view = projected.messages
    }
  }

  // ONE fused serialization pass feeds both the digest and the epoch-keyed
  // token estimate — each message content stringifies once, not twice. The
  // measured-usage reconciliation happens after settlement
  // (reconcileAppliedPlanUsage — the turn machine's first call of a turn).
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
