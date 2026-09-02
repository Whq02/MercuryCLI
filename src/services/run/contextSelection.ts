
import { createHash } from 'node:crypto'
import { flagEnv } from '../../substrate/flagRegistry.js'
import type { Message } from '../../types/message.js'
import { PERSISTED_OUTPUT_CLOSING_TAG, PERSISTED_OUTPUT_TAG } from '../../utils/toolResultStorage.js'
import type { OwnerKey } from './ownerKey.js'
import { registerOwnerScopedStore } from './ownerLifecycle.js'
import { OwnerScopedStore } from './ownerScopedStore.js'

export const CONTEXT_SELECTION_VERSION = 1 as const

export type ContextPolicyClass = 'preserve-all' | 'bounded-optional'

export function resolveSelectionPolicy(profileRequest?: ContextPolicyClass | null): ContextPolicyClass {
  const flag = flagEnv('MERCURY_CONTEXT_SELECTION')
  if (flag === 'bounded-optional') return 'bounded-optional'
  if (flag === 'preserve-all') return 'preserve-all'
  return profileRequest === 'bounded-optional' ? 'bounded-optional' : 'preserve-all'
}

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
  recordUuid: string
  viewIndex: number
}

export interface SelectionReduction {
  reasonCode: 'excluded:scored-out'
  span: SourceSpanRef
  itemType: string
  pointer: string
}

export type SelectionOverflow = 'none' | 'closure-exceeds-budget'

export interface ContextSelectionPlan {
  version: typeof CONTEXT_SELECTION_VERSION
  policy: ContextPolicyClass
  candidateCount: number
  requiredCount: number
  optionalCount: number
  excluded: SelectionReduction[]
  exclusionsCapped: boolean
  overflow: SelectionOverflow
  indexVisited: number
  indexMode: 'incremental' | 'rebase' | 'noop'
  digest: string
}


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


export const MAX_CANDIDATES = 4096
export const MAX_RECORDED_EXCLUSIONS = 200
export const MAX_FILE_EDGES = 32
const ACCESS_DECAY = 0.5

interface CandidateMeta {
  viewIndex: number
  itemType: string
  chars: number
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

export function peekCandidateIndex(owner: OwnerKey): Readonly<CandidateIndexState> | null {
  return candidateIndexes.peek(owner) ?? null
}

export function candidateIndexFor(owner: OwnerKey, mode: 'apply' | 'inspect'): CandidateIndexState {
  const live = candidateIndexes.get(owner)
  return mode === 'apply' ? live : cloneCandidateIndex(live)
}

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


export const REQUIRED_TAIL_MESSAGES = 10

export function computeRequiredClosure(view: Message[]): Map<number, RequiredReason> {
  const required = new Map<number, RequiredReason>()
  const mark = (i: number, reason: RequiredReason): void => {
    if (!required.has(i)) required.set(i, reason)
  }

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

  let latestCapsule = -1
  for (let i = 0; i < view.length; i++) {
    const m = view[i]! as { type?: string; isMeta?: boolean; isCompactSummary?: boolean }
    if (m.type === 'system' || m.isMeta) mark(i, 'required:instruction')
    if (m.isCompactSummary) latestCapsule = i
  }
  if (latestCapsule >= 0) mark(latestCapsule, 'required:decision-accepted')

  for (let i = Math.max(0, view.length - REQUIRED_TAIL_MESSAGES); i < view.length; i++) {
    mark(i, 'required:continuation-tail')
  }

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


export interface SelectionBudget {
  maxOptionalItems: number
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
    overflow = 'closure-exceeds-budget'
  }

  if (policy === 'bounded-optional' && budget && optionalIdx.length > budget.maxOptionalItems) {
    const wantDrop = optionalIdx.length - budget.maxOptionalItems
    const dropTarget = Math.min(wantDrop, MAX_RECORDED_EXCLUSIONS)
    if (wantDrop > dropTarget) exclusionsCapped = true

    const scored = optionalIdx.map(i => {
      const uuid = uuidOf(view[i]!)
      const meta = index.candidates.get(uuid)
      return { i, score: (meta?.score ?? 0) + i / Math.max(1, view.length) }
    })
    const dropSet = new Set<number>(lowestK(scored, dropTarget).map(x => x.i))

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
