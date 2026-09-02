// ============================================================================
//  model/modelTransition — the foreground ModelTransition machine (MERCURY
//  decision #7): boundary-safe main-loop model switching.
//
//  Laws:
//    - IDLE APPLY: with no foreground turn running, a pick applies
//      immediately (byte-parity with the legacy behavior — the idle path
//      is unchanged);
//    - ACTIVE-TURN PENDING: a pick while a foreground turn is streaming
//      never re-models the turn mid-flight (an Anthropic thinking-signature
//      continuation or a cross-provider replay must not switch wires between
//      tool rounds) — it parks as the visible "current → next" pending
//      switch and applies at the turn boundary;
//    - SAME-MODEL NO-OP: picking the effective model again changes nothing
//      and says so (and clears a pending switch — the operator re-chose the
//      current model);
//    - STALE-PENDING REJECTION: the pending slot holds ONE switch — a newer
//      pick REPLACES it;
//      application clears it exactly-once; a session switch drops it with
//      the rest of the session's AppState;
//    - CROSS-PROVIDER visibility: a switch that changes the PROVIDER family
//      (anthropic ↔ openai/zai) is flagged so the notification can say what
//      actually changes (transport + continuation shape), never silently.
//
//  PURE over its inputs — the scripts/model-routing suite drives the decision matrix
//  directly; the React seams (PromptInput picker, the REPL boundary effect)
//  consume the decision and own the state writes.
// ============================================================================
import { parseUserSpecifiedModel } from './model.js'
import {
  declaredRouteOf,
  providerDisplayName,
  type CallModelRoute,
} from '../../services/providers/routeLaw.js'

/** Provider families ARE the routing law's lanes (provider-08-21 —
 *  the local prefix copy this module carried was the display/dispatch-
 *  divergence class waiting to fire on a new family); 'unrecognised' is
 *  the honest word for a setting no family declares. */
export type ProviderFamily = CallModelRoute | 'unrecognised'

/** Provider family of a MODEL SETTING (alias or exact id; null = default).
 *  Absence resolves FIRST — a null setting takes the model owner's own
 *  'best' answer (the session's actual default), never a lane by
 *  remainder. */
export function providerFamilyOfSetting(setting: string | null): ProviderFamily {
  const resolved = parseUserSpecifiedModel(setting === null ? 'best' : setting)
  return declaredRouteOf(resolved) ?? 'unrecognised'
}

export type ModelTransitionDecision =
  | { kind: 'no-op-same' }
  | { kind: 'apply-now'; crossProvider: boolean }
  | { kind: 'defer-pending'; crossProvider: boolean }

export interface ModelTransitionInput {
  /** The EFFECTIVE current setting (session pin ?? persisted/base setting). */
  currentSetting: string | null
  /** The picked setting (null = the Default row). */
  nextSetting: string | null
  /** A foreground turn is running (the query guard's truth). */
  turnActive: boolean
}

/** The ONE foreground transition decision. */
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

// ── W1: the ONE settlement owner ─────────────────────────────────────
//  The decision above says WHAT should happen; settlement says what the state
//  write and the receipt ARE. Before this owner existed, the three consumers
//  hand-rolled their own writes and drifted (the /model command's no-op kept
//  a live pending switch the inline picker cancelled — the exact
//  second-local-version defect family closes). Every foreground apply
//  path — inline picker, /model command, the REPL turn-boundary effect, the
//  autopilot SetTier tool — now writes THIS patch and mints THIS receipt.

/** The exactly-once transition receipt (UN-06/07): minted at settlement,
 *  parked in AppState.lastModelTransition, projected once into the
 *  transcript by the REPL consumer effect. */
export interface ModelTransitionReceipt {
  /** The effective setting before settlement (null = the Default row). */
  previous: string | null
  /** The setting the operator (or autopilot) expressed. */
  requested: string | null
  /** The active setting after settlement. */
  applied: string | null
  resolution: 'applied' | 'cancelled-pending'
  /** Where it settled: an idle pick applies immediately; a queued pick at
   *  the foreground turn boundary; autopilot applies between model calls. */
  boundary: 'idle' | 'turn-boundary' | 'autopilot-tool'
  crossProvider: boolean
  /** Prompt-cache disposition (L4): dependency-keyed sections rebuild once
   *  at the next composition; nothing else moves. */
  cacheDisposition: 'keyed-sections-recompute-once' | 'none'
}

/** The AppState slice settlement reads and patches. */
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

/** Mint the settlement for a picker//model selection. Pure. */
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
    // SAME-MODEL NO-OP law: re-choosing the current model clears a live
    // pending switch (the operator re-chose the current model) — with a
    // receipt, because a queued transition just RESOLVED (cancelled).
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

/** Settle a parked switch at the foreground turn boundary (the REPL effect).
 *  Returns null when there is nothing to apply. */
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

/** The cross-provider notification suffix — what ACTUALLY changes. The ONE
 *  owner of this sentence (FN-016 R17 copy law): every surface that says a
 *  switch crosses families appends THIS, never a hand-rolled variant. The
 *  destination is named per its own declared family — the Anthropic-return
 *  sentence only when the destination IS Anthropic (it used to be the bare
 *  else, claiming a return for every lane the first two arms did not
 *  name), every other declared family through the one display owner, and
 *  an unrecognised setting claims only the change itself. */
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

// ── the frozen transition preview plan ────────────────────────────
//  The receipt above says what a settlement WAS; the plan says what a
//  REQUESTED transition WOULD DO to the canonical history — one frozen,
//  digest-addressed preview shared by preview and confirm (law 3: one
//  frozen plan). Dispositions are computed against the REAL encode truth
//  (services/providers/transitionPreview.ts builds plans; the prover pins
//  planner ≡ codec on the same history — the parity-oracle pattern), and
//  confirmation is STALE-SAFE: a history append or a capability flip since
//  the preview regenerates rather than applies. Settlement still flows
//  through settleModelSelection — the plan never writes state.

/** Typed per-item disposition classes — the verified loss vocabulary
 *  (ctm0-encode-loss.json ground truth). */
export type TransitionDispositionClass =
  | 'carried-exact'
  | 'tool-results-exact'
  | 'thinking-continuity-reset'
  | 'stateless-replay-reset'
  | 'image-degraded'
  | 'unknown-block-degraded'

/** The disposition classes that gate `needsChoice` (meaningful loss). */
export const MEANINGFUL_LOSS_CLASSES: readonly TransitionDispositionClass[] = [
  'thinking-continuity-reset',
  'stateless-replay-reset',
  'image-degraded',
  'unknown-block-degraded',
]

export type TransitionPlanItem = {
  /** The message uuid the disposition attaches to. */
  ref: string
  disposition: TransitionDispositionClass
  detail?: string
}

export type TransitionPlan = {
  v: 1
  /** Content-addressed sha256 over the explicit plan material — preview
   *  and confirm share THIS identity (the changeSetPlan planDigest form). */
  planDigest: string
  from: string | null
  to: string | null
  crossProvider: boolean
  targetRoute: ProviderFamily
  /** History identity at preview time (count · last uuid) — an append
   *  since the preview makes the plan stale. */
  sourceRevision: string
  /** Capability facts the dispositions depended on — a flip makes the
   *  plan stale. */
  capabilityEpoch: string
  /** Per-class totals over the WHOLE history (never truncated). */
  counts: Record<TransitionDispositionClass, number>
  /** The LOSSY items only (exact carries are the default); bounded at the
   *  builder's cap with `itemsTruncated` set — never a silent cap. */
  items: TransitionPlanItem[]
  itemsTruncated: boolean
  /** True when any meaningful-loss class has a nonzero count — the
   *  confirm surface must present a choice, never auto-apply. */
  needsChoice: boolean
  computedAt: string
}

/** Stale-safe confirmation (pure): the caller re-derives the CURRENT
 *  sourceRevision/capabilityEpoch and the plan either still speaks for the
 *  history or must regenerate. Settlement itself stays with
 *  settleModelSelection — confirm never writes. */
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
