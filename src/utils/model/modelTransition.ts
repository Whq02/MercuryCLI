import { parseUserSpecifiedModel } from './model.js'
import {
  declaredRouteOf,
  providerDisplayName,
  type CallModelRoute,
} from '../../services/providers/routeLaw.js'

export type ProviderFamily = CallModelRoute | 'unrecognised'

export function providerFamilyOfSetting(setting: string | null): ProviderFamily {
  const resolved = parseUserSpecifiedModel(setting === null ? 'best' : setting)
  return declaredRouteOf(resolved) ?? 'unrecognised'
}

export type ModelTransitionDecision =
  | { kind: 'no-op-same' }
  | { kind: 'apply-now'; crossProvider: boolean }
  | { kind: 'defer-pending'; crossProvider: boolean }

export interface ModelTransitionInput {
  currentSetting: string | null
  nextSetting: string | null
  turnActive: boolean
}

export function decideModelTransition(i: ModelTransitionInput): ModelTransitionDecision {
  const currentResolved =
    i.currentSetting === null ? null : parseUserSpecifiedModel(i.currentSetting)
  const nextResolved = i.nextSetting === null ? null : parseUserSpecifiedModel(i.nextSetting)
  if (currentResolved === nextResolved) {
    return { kind: 'no-op-same' }
  }
  const crossProvider =
    providerFamilyOfSetting(i.currentSetting) !== providerFamilyOfSetting(i.nextSetting)
  if (i.turnActive) {
    return { kind: 'defer-pending', crossProvider }
  }
  return { kind: 'apply-now', crossProvider }
}


export interface ModelTransitionReceipt {
  previous: string | null
  requested: string | null
  applied: string | null
  resolution: 'applied' | 'cancelled-pending'
  boundary: 'idle' | 'turn-boundary' | 'autopilot-tool'
  crossProvider: boolean
  cacheDisposition: 'keyed-sections-recompute-once' | 'none'
}

export interface TransitionStateSlice {
  mainLoopModel: string | null
  mainLoopModelForSession: string | null
  pendingModelSwitch: { setting: string | null } | null
  lastModelTransition?: ModelTransitionReceipt | null
}

export type SettledSelection =
  | { kind: 'no-op'; patch: null; receipt: null }
  | {
      kind: 'cancelled-pending'
      patch: Partial<TransitionStateSlice>
      receipt: ModelTransitionReceipt
    }
  | {
      kind: 'queued'
      patch: Partial<TransitionStateSlice>
      receipt: null
      crossProvider: boolean
    }
  | {
      kind: 'applied'
      patch: Partial<TransitionStateSlice>
      receipt: ModelTransitionReceipt
    }

export function settleModelSelection(
  prev: TransitionStateSlice,
  next: string | null,
  opts: {
    turnActive: boolean
    boundary?: 'idle' | 'autopilot-tool'
  },
): SettledSelection {
  const current = prev.mainLoopModelForSession ?? prev.mainLoopModel
  const decision = decideModelTransition({
    currentSetting: current,
    nextSetting: next,
    turnActive: opts.turnActive,
  })
  if (decision.kind === 'no-op-same') {
    if (prev.pendingModelSwitch !== null) {
      const receipt: ModelTransitionReceipt = {
        previous: current,
        requested: prev.pendingModelSwitch.setting,
        applied: current,
        resolution: 'cancelled-pending',
        boundary: opts.boundary ?? 'idle',
        crossProvider: false,
        cacheDisposition: 'none',
      }
      return {
        kind: 'cancelled-pending',
        patch: { pendingModelSwitch: null, lastModelTransition: receipt },
        receipt,
      }
    }
    return { kind: 'no-op', patch: null, receipt: null }
  }
  if (decision.kind === 'defer-pending') {
    return {
      kind: 'queued',
      patch: { pendingModelSwitch: { setting: next } },
      receipt: null,
      crossProvider: decision.crossProvider,
    }
  }
  const receipt: ModelTransitionReceipt = {
    previous: current,
    requested: next,
    applied: next,
    resolution: 'applied',
    boundary: opts.boundary ?? 'idle',
    crossProvider: decision.crossProvider,
    cacheDisposition: 'keyed-sections-recompute-once',
  }
  return {
    kind: 'applied',
    patch: {
      mainLoopModel: next,
      mainLoopModelForSession: null,
      pendingModelSwitch: null,
      lastModelTransition: receipt,
    },
    receipt,
  }
}

export function settlePendingAtBoundary(
  prev: TransitionStateSlice,
): { patch: Partial<TransitionStateSlice>; receipt: ModelTransitionReceipt } | null {
  if (prev.pendingModelSwitch === null) return null
  const next = prev.pendingModelSwitch.setting
  const current = prev.mainLoopModelForSession ?? prev.mainLoopModel
  const receipt: ModelTransitionReceipt = {
    previous: current,
    requested: next,
    applied: next,
    resolution: 'applied',
    boundary: 'turn-boundary',
    crossProvider:
      providerFamilyOfSetting(current) !== providerFamilyOfSetting(next),
    cacheDisposition: 'keyed-sections-recompute-once',
  }
  return {
    patch: {
      mainLoopModel: next,
      mainLoopModelForSession: null,
      pendingModelSwitch: null,
      lastModelTransition: receipt,
    },
    receipt,
  }
}

export function crossProviderNote(next: string | null): string {
  const family = providerFamilyOfSetting(next)
  if (family === 'openai') {
    return ' · cross-provider: turns move to the native OpenAI Responses transport (history replays statelessly; Anthropic thinking never round-trips)'
  }
  if (family === 'zai') {
    return ' · cross-provider: turns move to the native Z.AI transport'
  }
  if (family === 'anthropic') {
    return ' · cross-provider: turns return to the Anthropic transport'
  }
  if (family === 'unrecognised') {
    return ' · cross-provider: the transport changes with it'
  }
  return ` · cross-provider: turns move to the ${providerDisplayName(family)} transport`
}


export type TransitionDispositionClass =
  | 'carried-exact'
  | 'tool-results-exact'
  | 'thinking-continuity-reset'
  | 'stateless-replay-reset'
  | 'image-degraded'
  | 'unknown-block-degraded'

export const MEANINGFUL_LOSS_CLASSES: readonly TransitionDispositionClass[] = [
  'thinking-continuity-reset',
  'stateless-replay-reset',
  'image-degraded',
  'unknown-block-degraded',
]

export type TransitionPlanItem = {
  ref: string
  disposition: TransitionDispositionClass
  detail?: string
}

export type TransitionPlan = {
  v: 1
  planDigest: string
  from: string | null
  to: string | null
  crossProvider: boolean
  targetRoute: ProviderFamily
  sourceRevision: string
  capabilityEpoch: string
  counts: Record<TransitionDispositionClass, number>
  items: TransitionPlanItem[]
  itemsTruncated: boolean
  needsChoice: boolean
  computedAt: string
}

export function confirmTransitionPlan(
  plan: TransitionPlan,
  current: { sourceRevision: string; capabilityEpoch: string },
):
  | { ok: true }
  | { ok: false; reason: 'stale-source' | 'stale-capability' } {
  if (plan.sourceRevision !== current.sourceRevision) {
    return { ok: false, reason: 'stale-source' }
  }
  if (plan.capabilityEpoch !== current.capabilityEpoch) {
    return { ok: false, reason: 'stale-capability' }
  }
  return { ok: true }
}
