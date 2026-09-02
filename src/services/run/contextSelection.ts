// ============================================================================
//  run/contextSelection — the SELECTION stage.
//
//  Runs AHEAD of the reducers inside buildRequestContextPlan (the ONE
//  builder — /context inherits automatically). Laws:
//
//    · REQUIRED CLOSURE FIRST: the active operator request,
//      instruction/identity rows, the ACCEPTED decision capsule (older
//      capsules are superseded — excludable), unresolved and paired tool
//      calls, file/evidence dependency edges, and the minimum continuation
//      tail are computed BEFORE any optional scoring and can never be
//      excluded. Closure that exceeds an explicit total budget returns a
//      TYPED overflow state — never a forced drop.
//    · selection ≠ destruction: the stage projects a VIEW; canonical
//      history and the persisted store are never touched. This module
//      performs no fs writes and imports no provider/codec surface.
//    · every exclusion is accountable: a stable reason code plus an
//      exact source reference (record uuid; the transcript ordinal universe
//      retrieves it byte-true) in the <persisted-output> pointer shape —
//      never fabricated summary text.
//    · bounded + incremental: the per-owner candidate index folds
//      ONLY the suffix past its watermark (a rebase refolds once, honestly
//      counted), decays access aggregates, and reaps above a hard cap by
//      iterator-front eviction. NO history-sized sort runs per sampling
//      step — the exclusion pick keeps a bounded worst-set in one pass.
//    · policy classes: 'preserve-all' (DEFAULT — the projected view is
//      byte-identical to today's) · 'bounded-optional' (armed via the
//      registered MERCURY_CONTEXT_SELECTION flag: optional items beyond the
//      explicit budget are excluded, lowest score first). Unknown values
//      degrade to 'preserve-all'.
// ============================================================================

import { createHash } from 'node:crypto'
import { flagEnv } from '../../substrate/flagRegistry.js'
import type { Message } from '../../types/message.js'
import { PERSISTED_OUTPUT_CLOSING_TAG, PERSISTED_OUTPUT_TAG } from '../../utils/toolResultStorage.js'
import type { OwnerKey } from './ownerKey.js'
import { registerOwnerScopedStore } from './ownerLifecycle.js'
import { OwnerScopedStore } from './ownerScopedStore.js'

export const CONTEXT_SELECTION_VERSION = 1 as const

export type ContextPolicyClass = 'preserve-all' | 'bounded-optional'

/** The policy read. Precedence (operator choice wins):
 *  an EXPLICIT `MERCURY_CONTEXT_SELECTION` value (either class) outranks
 *  everything · else the harness-profile REQUEST (an owner-published state a
 *  resolved profile asks for — the accepted defaults request 'preserve-all',
 *  so unarmed and armed-default behaviour stay byte-identical) · else
 *  'preserve-all'. Unknown values in either input degrade to
 *  'preserve-all'. */
export function resolveSelectionPolicy(profileRequest?: ContextPolicyClass | null): ContextPolicyClass {
  const flag = flagEnv('MERCURY_CONTEXT_SELECTION')
  if (flag === 'bounded-optional') return 'bounded-optional'
  if (flag === 'preserve-all') return 'preserve-all'
  return profileRequest === 'bounded-optional' ? 'bounded-optional' : 'preserve-all'
}

/**
 * The budget-publishing owner: the ONE resolution of the
 * selection budget the builder threads. Precedence mirrors the policy
 * resolver exactly — the operator's explicit flag outranks a caller-supplied
 * budget; unset ⇒ the caller's value ⇒ null (byte-identical earlier
 * behavior — the accepted default). Value grammar:
 * `MERCURY_SELECTION_BUDGET=<maxOptionalItems>[,<maxTotalItems>]` —
 * maxOptionalItems clamps to [0, 10000]; a total below it drops the total
 * bound with a note (never a forced drop); a malformed value resolves to the
 * caller's budget with a note — an invalid operator value must not silently
 * change selection behavior.
 */
export interface SelectionBudgetResolution {
  budget: SelectionBudget | null
  source: 'flag' | 'caller' | 'none'
  note?: string
}

export function resolveSelectionBudget(
  callerBudget?: SelectionBudget | null,
): SelectionBudgetResolution {
  const raw = flagEnv('MERCURY_SELECTION_BUDGET')
  if (raw !== undefined && raw !== '') {
    const m = /^(\d+)(?:,(\d+))?$/.exec(raw.trim())
    if (m) {
      const maxOptionalItems = Math.min(10_000, Math.max(0, Number(m[1])))
      const total = m[2] !== undefined ? Number(m[2]) : undefined
      if (total !== undefined && total >= maxOptionalItems) {
        return { budget: { maxOptionalItems, maxTotalItems: total }, source: 'flag' }
      }
      return {
        budget: { maxOptionalItems },
        source: 'flag',
        ...(total !== undefined
          ? { note: `selection budget flag maxTotalItems ${total} below maxOptionalItems — total bound ignored` }
          : {}),
      }
    }
    return {
      budget: callerBudget ?? null,
      source: callerBudget ? 'caller' : 'none',
      note: `selection budget flag malformed ('${raw.slice(0, 40)}') — ignored`,
    }
  }
  if (callerBudget) return { budget: callerBudget, source: 'caller' }
  return { budget: null, source: 'none' }
}

export type RequiredReason =
  | 'required:operator-request'
  | 'required:instruction'
  | 'required:decision-accepted'
  | 'required:continuation-tail'
  | 'required:tool-pair'
  | 'required:unresolved-tool'
  | 'required:dependency'

export interface SourceSpanRef {
  /** The record's message identity — the transcript ordinal universe
   *  retrieves the full source by uuid (materialize walk), byte-true. */
  recordUuid: string
  /** Position in the projected view at exclusion time (0-based). */
  viewIndex: number
}

export interface SelectionReduction {
  reasonCode: 'excluded:scored-out'
  span: SourceSpanRef
  itemType: string
  /** Retrievable pointer (the <persisted-output> shape) — mechanical
   *  retrieval reference only, never fabricated summary text. */
  pointer: string
}

export type SelectionOverflow = 'none' | 'closure-exceeds-budget'

export interface ContextSelectionPlan {
  version: typeof CONTEXT_SELECTION_VERSION
  policy: ContextPolicyClass
  /** Candidate universe (the projected view) at this step. */
  candidateCount: number
  requiredCount: number
  optionalCount: number
  /** Exclusions this step (bounded-optional only; explicitly capped). */
  excluded: SelectionReduction[]
  /** True when the exclusion list hit its explicit cap. */
  exclusionsCapped: boolean
  /** Typed closure-overflow state: required closure alone exceeds an
   *  explicit total budget — reported, never force-dropped. */
  overflow: SelectionOverflow
  /** accounting: index entries visited by THIS build (suffix-only;
   *  a watermark rebase refolds once and reports it). */
  indexVisited: number
  /** Why the index visited what it did ('incremental' | 'rebase' | 'noop'). */
  indexMode: 'incremental' | 'rebase' | 'noop'
  /** sha256 over the ordered decisions — deterministic for identical
   *  inputs + index state. */
  digest: string
}

// ── message probes (structure-only; no content interpretation) ──────────────

const uuidOf = (m: Message): string => (m as { uuid?: string }).uuid ?? ''
const typeOf = (m: Message): string => (m as { type?: string }).type ?? '?'
const charsOf = (m: Message): number => {
  const content = (m as { message?: { content?: unknown } }).message?.content
  if (typeof content === 'string') return content.length
  try {
    return JSON.stringify(content ?? null)?.length ?? 0
  } catch {
    return 0
  }
}

function toolUseBlocksOf(m: Message): Array<{ id: string; input: unknown }> {
  const content = (m as { message?: { content?: unknown } }).message?.content
  if (!Array.isArray(content)) return []
  return (content as Array<{ type?: string; id?: string; input?: unknown }>)
    .filter(b => b?.type === 'tool_use' && typeof b.id === 'string')
    .map(b => ({ id: b.id as string, input: b.input }))
}

function toolResultIdsOf(m: Message): string[] {
  const content = (m as { message?: { content?: unknown } }).message?.content
  if (!Array.isArray(content)) return []
  return (content as Array<{ type?: string; tool_use_id?: string }>)
    .filter(b => b?.type === 'tool_result' && typeof b.tool_use_id === 'string')
    .map(b => b.tool_use_id as string)
}

/** File/evidence references from STRUCTURED tool inputs only (no content
 *  grep): the conventional path-shaped argument names. */
function filePathsOf(m: Message): string[] {
  const out: string[] = []
  for (const b of toolUseBlocksOf(m)) {
    const input = b.input as Record<string, unknown> | undefined
    if (!input || typeof input !== 'object') continue
    for (const key of ['file_path', 'path', 'notebook_path']) {
      const v = input[key]
      if (typeof v === 'string' && v.length > 0) out.push(v)
    }
  }
  return out
}

function isRealUserMessage(m: Message): boolean {
  if (typeOf(m) !== 'user') return false
  if ((m as { isMeta?: boolean }).isMeta) return false
  return toolResultIdsOf(m).length === 0
}

// ── the bounded incremental candidate index ───────────────────────

export const MAX_CANDIDATES = 4096
export const MAX_RECORDED_EXCLUSIONS = 200
/** Distinct file-dependency edges retained (most recent win). */
export const MAX_FILE_EDGES = 32
/** Access-aggregate decay per fold round — bounded, recency-weighted. */
const ACCESS_DECAY = 0.5

interface CandidateMeta {
  viewIndex: number
  itemType: string
  chars: number
  /** Decayed access/selection aggregate (bounded by construction). */
  score: number
}

interface CandidateIndexState {
  watermarkCount: number
  firstUuid: string | null
  lastUuid: string | null
  candidates: Map<string, CandidateMeta>
  folds: number
}

const emptyIndex = (): CandidateIndexState => ({
  watermarkCount: 0,
  firstUuid: null,
  lastUuid: null,
  candidates: new Map(),
  folds: 0,
})

const candidateIndexes = new OwnerScopedStore<CandidateIndexState>({
  name: 'context-selection-index',
  create: emptyIndex,
})
registerOwnerScopedStore(candidateIndexes)

export function cloneCandidateIndex(state: CandidateIndexState): CandidateIndexState {
  return {
    watermarkCount: state.watermarkCount,
    firstUuid: state.firstUuid,
    lastUuid: state.lastUuid,
    candidates: new Map([...state.candidates].map(([k, v]) => [k, { ...v }])),
    folds: state.folds,
  }
}

/** Peek the live index (proof/inspection surface — never mutates). */
export function peekCandidateIndex(owner: OwnerKey): Readonly<CandidateIndexState> | null {
  return candidateIndexes.peek(owner) ?? null
}

/** Resolve the index state for a build: apply mutates the owner store,
 *  inspect works on a CLONE so inspection can never move the watermark. */
export function candidateIndexFor(owner: OwnerKey, mode: 'apply' | 'inspect'): CandidateIndexState {
  const live = candidateIndexes.get(owner)
  return mode === 'apply' ? live : cloneCandidateIndex(live)
}

/** Fold the view into the index, visiting ONLY the suffix past the
 *  watermark. A mismatched prefix (compact/rewind rebuilt the view)
 *  refolds from scratch exactly once, honestly reported. Reap is
 *  iterator-front eviction (insertion order) — never a sort. */
export function updateCandidateIndex(
  state: CandidateIndexState,
  view: Message[],
): { visited: number; mode: ContextSelectionPlan['indexMode'] } {
  const first = view.length > 0 ? uuidOf(view[0]!) : null
  const last = view.length > 0 ? uuidOf(view[view.length - 1]!) : null
  const unchanged =
    view.length === state.watermarkCount && first === state.firstUuid && last === state.lastUuid
  if (unchanged) return { visited: 0, mode: 'noop' }

  const prefixIntact =
    state.watermarkCount > 0 &&
    view.length >= state.watermarkCount &&
    first === state.firstUuid &&
    uuidOf(view[state.watermarkCount - 1]!) === state.lastUuid
  const from = prefixIntact ? state.watermarkCount : 0
  if (!prefixIntact) state.candidates.clear()

  // Decay standing aggregates once per fold round (bounded by construction).
  for (const meta of state.candidates.values()) meta.score *= ACCESS_DECAY

  let visited = 0
  for (let i = from; i < view.length; i++) {
    const m = view[i]!
    visited++
    const uuid = uuidOf(m)
    if (!uuid) continue
    state.candidates.set(uuid, {
      viewIndex: i,
      itemType: typeOf(m),
      chars: charsOf(m),
      score: 1,
    })
  }
  // Reap above the hard cap: evict from the iterator front (oldest
  // insertions — ascending view positions by construction). O(overflow).
  if (state.candidates.size > MAX_CANDIDATES) {
    let overflow = state.candidates.size - MAX_CANDIDATES
    for (const uuid of state.candidates.keys()) {
      if (overflow-- <= 0) break
      state.candidates.delete(uuid)
    }
  }
  state.watermarkCount = view.length
  state.firstUuid = first
  state.lastUuid = last
  state.folds++
  return { visited, mode: prefixIntact ? 'incremental' : 'rebase' }
}

// ── required closure ──────────────────────────────────────────────────

/** Minimum continuation tail — the most recent turns always travel. */
export const REQUIRED_TAIL_MESSAGES = 10

/** Compute the required set FIRST — indexes into the view that optional
 *  scoring may never touch. Returns per-index reasons (first reason wins). */
export function computeRequiredClosure(view: Message[]): Map<number, RequiredReason> {
  const required = new Map<number, RequiredReason>()
  const mark = (i: number, reason: RequiredReason): void => {
    if (!required.has(i)) required.set(i, reason)
  }

  // 1. The active operator request: the last real user message and
  //    everything after it (the in-flight exchange).
  let lastUser = -1
  for (let i = view.length - 1; i >= 0; i--) {
    if (isRealUserMessage(view[i]!)) {
      lastUser = i
      break
    }
  }
  if (lastUser >= 0) {
    for (let i = lastUser; i < view.length; i++) mark(i, 'required:operator-request')
  }

  // 2. Identity/instruction contracts: system rows and meta rows. The
  //    ACCEPTED decision capsule = the LATEST compact summary; older
  //    capsules are SUPERSEDED (excludable — supersession is real).
  let latestCapsule = -1
  for (let i = 0; i < view.length; i++) {
    const m = view[i]! as { type?: string; isMeta?: boolean; isCompactSummary?: boolean }
    if (m.type === 'system' || m.isMeta) mark(i, 'required:instruction')
    if (m.isCompactSummary) latestCapsule = i
  }
  if (latestCapsule >= 0) mark(latestCapsule, 'required:decision-accepted')

  // 3. The minimum continuation tail.
  for (let i = Math.max(0, view.length - REQUIRED_TAIL_MESSAGES); i < view.length; i++) {
    mark(i, 'required:continuation-tail')
  }

  // 4. Tool pairing closure to a fixed point: a retained result keeps its
  //    use; a use with no result in view is unresolved and stays. File/
  //    evidence dependency edges ride the same walk: the LATEST tool pair
  //    per referenced path (bounded) is retained evidence.
  const useAt = new Map<string, number>()
  const resultAt = new Map<string, number>()
  const latestPathUse = new Map<string, string>()
  for (let i = 0; i < view.length; i++) {
    const m = view[i]!
    for (const b of toolUseBlocksOf(m)) useAt.set(b.id, i)
    for (const id of toolResultIdsOf(m)) resultAt.set(id, i)
    for (const p of filePathsOf(m)) {
      const blocks = toolUseBlocksOf(m)
      if (blocks.length > 0) latestPathUse.set(p, blocks[0]!.id)
      if (latestPathUse.size > MAX_FILE_EDGES) {
        // Bounded: evict the oldest edge (iterator front).
        const oldest = latestPathUse.keys().next().value as string | undefined
        if (oldest !== undefined) latestPathUse.delete(oldest)
      }
    }
  }
  for (const [id, useIdx] of useAt) {
    if (!resultAt.has(id)) mark(useIdx, 'required:unresolved-tool')
  }
  for (const id of latestPathUse.values()) {
    const useIdx = useAt.get(id)
    if (useIdx !== undefined) mark(useIdx, 'required:dependency')
  }
  let moved = true
  while (moved) {
    moved = false
    for (const [id, resIdx] of resultAt) {
      const useIdx = useAt.get(id)
      if (useIdx === undefined) continue
      const resRequired = required.has(resIdx)
      const useRequired = required.has(useIdx)
      if (resRequired && !useRequired) {
        mark(useIdx, 'required:tool-pair')
        moved = true
      } else if (useRequired && !resRequired) {
        mark(resIdx, 'required:tool-pair')
        moved = true
      }
    }
  }
  return required
}

// ── the selection stage ─────────────────────────────────────────────────────

export interface SelectionBudget {
  /** Explicit bound on retained OPTIONAL items (a bounded reviewable
   *  heuristic — never applies to the required set). */
  maxOptionalItems: number
  /** Optional explicit TOTAL bound: required closure alone exceeding it
   *  reports the typed overflow state (never a forced drop). */
  maxTotalItems?: number
}

function exclusionPointer(uuid: string, viewIndex: number): string {
  return (
    `${PERSISTED_OUTPUT_TAG}\n` +
    `Excluded from request context by selection (reason: excluded:scored-out). ` +
    `Full source: session transcript record ${uuid} (view position ${viewIndex}). ` +
    `Retrieve byte-true from the transcript by record uuid (timeline / materialize).\n` +
    PERSISTED_OUTPUT_CLOSING_TAG
  )
}

function selectionDigest(
  policy: ContextPolicyClass,
  retained: string[],
  excluded: SelectionReduction[],
): string {
  const h = createHash('sha256')
  h.update(`v${CONTEXT_SELECTION_VERSION}:${policy}`)
  for (const u of retained) h.update(` r${u}`)
  for (const e of excluded) h.update(` x${e.span.recordUuid}:${e.reasonCode}`)
  return h.digest('hex')
}

export interface SelectionStageResult {
  view: Message[]
  selection: ContextSelectionPlan
}

/** One-pass bounded pick of the k lowest-scored indexes — never a
 *  history-sized sort. k is small by construction (≤ the explicit
 *  exclusion cap), so linear insertion stays bounded. */
function lowestK(
  items: Array<{ i: number; score: number }>,
  k: number,
): Array<{ i: number; score: number }> {
  const worst: Array<{ i: number; score: number }> = []
  for (const item of items) {
    if (worst.length < k) {
      let at = worst.length
      while (at > 0 && (worst[at - 1]!.score > item.score || (worst[at - 1]!.score === item.score && worst[at - 1]!.i > item.i))) at--
      worst.splice(at, 0, item)
    } else if (k > 0) {
      const max = worst[k - 1]!
      if (item.score < max.score || (item.score === max.score && item.i < max.i)) {
        worst.pop()
        let at = worst.length
        while (at > 0 && (worst[at - 1]!.score > item.score || (worst[at - 1]!.score === item.score && worst[at - 1]!.i > item.i))) at--
        worst.splice(at, 0, item)
      }
    }
  }
  return worst
}

/** The SELECTION stage. preserve-all: the returned view is the INPUT ARRAY
 *  (byte-identical projection — today's behavior); the plan still carries
 *  honest candidate/index accounting. bounded-optional: optional items
 *  beyond the budget leave, lowest score first, required closure untouched. */
export function runSelectionStage(
  view: Message[],
  policy: ContextPolicyClass,
  index: CandidateIndexState,
  budget: SelectionBudget | null,
): SelectionStageResult {
  const { visited, mode } = updateCandidateIndex(index, view)
  const required = computeRequiredClosure(view)
  const optionalIdx: number[] = []
  for (let i = 0; i < view.length; i++) {
    if (!required.has(i)) optionalIdx.push(i)
  }

  let outView = view
  const excluded: SelectionReduction[] = []
  let exclusionsCapped = false
  let overflow: SelectionOverflow = 'none'

  if (
    budget &&
    typeof budget.maxTotalItems === 'number' &&
    required.size > budget.maxTotalItems
  ) {
    // Required closure alone exceeds the explicit total budget: the TYPED
    // choice state — selection never force-drops required material.
    overflow = 'closure-exceeds-budget'
  }

  if (policy === 'bounded-optional' && budget && optionalIdx.length > budget.maxOptionalItems) {
    const wantDrop = optionalIdx.length - budget.maxOptionalItems
    const dropTarget = Math.min(wantDrop, MAX_RECORDED_EXCLUSIONS)
    if (wantDrop > dropTarget) exclusionsCapped = true

    // Score optional items (standing aggregate + recency) and pick the
    // bounded worst set in one pass — no history-sized sort.
    const scored = optionalIdx.map(i => {
      const uuid = uuidOf(view[i]!)
      const meta = index.candidates.get(uuid)
      return { i, score: (meta?.score ?? 0) + i / Math.max(1, view.length) }
    })
    const dropSet = new Set<number>(lowestK(scored, dropTarget).map(x => x.i))

    // Pairing repair: the OUTPUT view must never orphan a tool pair — if
    // exactly one endpoint of a pair would drop, keep both (retention-
    // biased; multi-id messages can re-couple, so iterate to a fixed point).
    const pairEdges: Array<[number, number]> = []
    {
      const useAt = new Map<string, number>()
      const resultAt = new Map<string, number>()
      for (let i = 0; i < view.length; i++) {
        for (const b of toolUseBlocksOf(view[i]!)) useAt.set(b.id, i)
        for (const id of toolResultIdsOf(view[i]!)) resultAt.set(id, i)
      }
      for (const [id, useIdx] of useAt) {
        const resIdx = resultAt.get(id)
        if (resIdx !== undefined && useIdx !== resIdx) pairEdges.push([useIdx, resIdx])
      }
    }
    let repaired = true
    while (repaired) {
      repaired = false
      for (const [a, b] of pairEdges) {
        const dropA = dropSet.has(a)
        const dropB = dropSet.has(b)
        if (dropA !== dropB) {
          dropSet.delete(dropA ? a : b)
          repaired = true
        }
      }
    }
    for (const i of [...dropSet].sort((a, b) => a - b)) {
      const uuid = uuidOf(view[i]!)
      excluded.push({
        reasonCode: 'excluded:scored-out',
        span: { recordUuid: uuid, viewIndex: i },
        itemType: typeOf(view[i]!),
        pointer: exclusionPointer(uuid, i),
      })
    }
    if (dropSet.size > 0) {
      outView = view.filter((_, i) => !dropSet.has(i))
    }
  }

  const retainedUuids = outView.map(uuidOf)
  const selection: ContextSelectionPlan = Object.freeze({
    version: CONTEXT_SELECTION_VERSION,
    policy,
    candidateCount: view.length,
    requiredCount: required.size,
    optionalCount: optionalIdx.length,
    excluded: Object.freeze(excluded.map(e => Object.freeze(e))) as SelectionReduction[],
    exclusionsCapped,
    overflow,
    indexVisited: visited,
    indexMode: mode,
    digest: selectionDigest(policy, retainedUuids, excluded),
  })
  return { view: outView, selection }
}
