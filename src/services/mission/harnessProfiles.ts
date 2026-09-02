// ============================================================================
//  services/mission/harnessProfiles — the HarnessProfile owner.
//
//  ONE closed, reviewable catalogue of named, versioned, digest-stable
//  harness profiles + ONE pure resolver over an immutable input snapshot.
//  The policyProfiles sibling: where
//  mission profiles answer "how is this TASK executed", a harness
//  profile answers "how is the harness CONFIGURED around the model actually
//  doing the work" — bounded axes over owner-published states only. The
//  invariant floor (permissions/consent, transactional editing, acceptance
//  checks, durable identity, error states, persistence bounds, the
//  completion/evidence contract) is OUTSIDE profile reach by construction:
//  no axis names it, and the application layer maps axis states only onto
//  the six owning subsystems' published knobs.
//
//  Naming law: the noun is HarnessProfile everywhere;
//  digests are hpr1- (profile) / hprs1- (set) / he1- (evidence epoch); the
//  flag family is MERCURY_HARNESS_PROFILE*. Four sibling profile
//  vocabularies live in this repo (instruction profiles · MissionPolicyProfile
//  · MercurySessionProfile/MercuryBehaviorProfile · capsuleProfile values);
//  every exported symbol here carries the Harness prefix so none collide.
//
//  Epoch law (CH-40): the harness evidence epoch COMPOSES
//  APEX_ARCHITECTURE_EPOCH — it never bumps it (bumping retires OpenAI
//  qualification receipts + all mission history; that is an event
//  needing its own operator ruling). The architecture identity
//  binds ONCE here.
//
//  Selection laws (each mechanically proved by scripts/harness-profiles/):
//    · valid session pin > valid persisted pin > qualified selector >
//      accepted default; invalid/unavailable pins fall through with a NAMED
//      reason — never a silent substitute; reset (null pins) returns to the
//      selector;
//    · a session pin may select any non-retired profile (the dev/experiment
//      instrument); a persisted pin only qualified|accepted (durable
//      defaults never point at dev candidates);
//    · an unknown model (absent from every owning catalogue) takes the
//      provider family's accepted default with a NAMED conservative reason
//      until qualified (CH-14);
//    · history routes only when BOTH the qualified candidate and the family
//      default carry epoch-current, sample-floored rows AND the candidate
//      measurably beats the default — indistinguishable evidence keeps the
//      simpler accepted default (named);
//    · low-sample / wrong-epoch history is IGNORED (named);
//    · resolution is deterministic on identical inputs, cached by
//      facts+set digests, and does zero per-render/per-token work.
// ============================================================================

import { createHash } from 'node:crypto'
import { OUTCOME_MIN_SAMPLES } from '../../utils/router/routeCompiler.js'
import type { CallModelRoute } from '../providers/callModelRouter.js'
import type { EffortLevel } from '../../utils/effort.js'
import type { RouteTaskShape } from '../../utils/router/contracts.js'
import type { ContextPolicyClass } from '../run/contextSelection.js'

export const HARNESS_PROFILE_IDS = [
  'anthropic-default',
  'openai-default',
  'zai-default',
  'chat-engine-default',
  'anthropic-context-bounded',
] as const
export type HarnessProfileId = (typeof HARNESS_PROFILE_IDS)[number]

/** Estate cap (the contract): at most eight qualified/accepted postures
 *  across the whole catalogue; adding one requires evidence an existing
 *  profile cannot express the measured distinction. */
export const HARNESS_MAX_QUALIFIED_POSTURES = 8

export type HarnessProfileStatus = 'candidate' | 'qualified' | 'accepted' | 'retired'

/** Bounded axes — owner-published states only. Every 'standard' /
 *  'owner-default' / 'provider-default' / 'mission-owned' value is the
 *  identity state: applying it changes NOTHING (the accepted defaults are
 *  byte-identical to the profile-less behaviour by construction). Non-identity
 *  states are minted exclusively by measured candidates. */
export interface HarnessProfileAxes {
  context: {
    /** Owner-published selection policy (contextSelection.ContextPolicyClass). */
    selectionPolicy: ContextPolicyClass
    /** Allocation band consumed at requestContextPlan (planVersion 2).
     *  'standard' = the owner's current budget untouched. */
    allocationBand: 'standard' | 'lean' | 'rich'
  }
  toolPresentation: {
    /** Catalogue grouping/visibility; 'standard' = today's pool assembly. */
    catalogue: 'standard' | 'grouped-compact'
    /** Parallel tool-call allowance; 'provider-default' = whatever provider
     *  AND tool owners declare today. Permission semantics untouchable. */
    parallelCalls: 'provider-default' | 'discouraged'
  }
  editingPosture: {
    /** Preference among the existing transaction owners (anchored
     *  single / multi-hunk · ChangeSet); 'owner-default' = today's
     *  selection logic. Transaction laws untouchable. */
    preference: 'owner-default' | 'anchored-single' | 'multi-hunk' | 'changeset'
  }
  verificationPosture: {
    /** Focused-check cadence band during construction. */
    focusedCadence: 'standard' | 'sparse' | 'dense'
    /** Fresh-context reviewer band — a supported band a policy runner MAY consume;
     *  stays the mission authority (never overruled, never widened).
     *  The final required gate never varies. */
    reviewerBand: 'mission-owned' | 'on-completion-supported' | 'none-supported'
  }
  delegationTopology: {
    /** Compatibility FACTS consumed downstream — constrain-only; task
     *  structure dominates; agent count is never a target. */
    supportedExecution: readonly ('solo' | 'routed' | 'workflow')[]
    maxConcurrentLanes: 1 | 2 | 3
  }
  turnRecovery: {
    /** Request timeout class per model/effort; 'standard' = the provider
     *  owners' current budgets. */
    timeoutClass: 'standard' | 'extended'
    /** Progress/heartbeat cadence for long turns. */
    heartbeat: 'standard' | 'dense'
  }
}

export interface HarnessProfile {
  schema: 1
  id: HarnessProfileId
  version: number
  status: HarnessProfileStatus
  description: string
  compatibility: {
    providerFamilies: readonly CallModelRoute[]
    /** Empty = no additional restriction beyond providerFamilies. */
    modelFamilies: readonly string[]
    /** Empty = every supported effort level. */
    effortLevels: readonly EffortLevel[]
    /** Capability fact names the application layer must confirm; empty =
     *  none required. */
    requiredCapabilities: readonly string[]
  }
  taskEnvelope: {
    /** RouteTaskShape values; empty = every task family. */
    families: readonly RouteTaskShape[]
    /** Empty = every complexity band. */
    complexityBands: readonly string[]
  }
  axes: HarnessProfileAxes
  /** Evidence anchor (a section, row, or path reference). */
  evidenceRef?: string
  /** The already-green profile a rollback lands on; accepted defaults roll
   *  back to themselves (they ARE the profile-less behaviour). */
  rollbackProfileId: HarnessProfileId
}

const IDENTITY_AXES_WIDE: HarnessProfileAxes = {
  context: { selectionPolicy: 'preserve-all', allocationBand: 'standard' },
  toolPresentation: { catalogue: 'standard', parallelCalls: 'provider-default' },
  editingPosture: { preference: 'owner-default' },
  verificationPosture: { focusedCadence: 'standard', reviewerBand: 'mission-owned' },
  delegationTopology: { supportedExecution: ['solo', 'routed', 'workflow'], maxConcurrentLanes: 3 },
  turnRecovery: { timeoutClass: 'standard', heartbeat: 'standard' },
}

/** The GPT and GLM lanes run solo at width 1 today (the specialist-sol
 *  mission ceiling); recording that as the compatibility FACT matches the
 *  live estate — constrain-only, and a no-op against own caps. */
const IDENTITY_AXES_SOLO: HarnessProfileAxes = {
  ...IDENTITY_AXES_WIDE,
  delegationTopology: { supportedExecution: ['solo'], maxConcurrentLanes: 1 },
}

export const HARNESS_PROFILES: readonly HarnessProfile[] = [
  {
    schema: 1,
    id: 'anthropic-default',
    version: 1,
    status: 'accepted',
    description: 'the Anthropic-lane accepted default — byte-identical to the unarmed behaviour',
    compatibility: { providerFamilies: ['anthropic'], modelFamilies: [], effortLevels: [], requiredCapabilities: [] },
    taskEnvelope: { families: [], complexityBands: [] },
    axes: IDENTITY_AXES_WIDE,
    evidenceRef: 'the accepted policy at bind',
    rollbackProfileId: 'anthropic-default',
  },
  {
    schema: 1,
    id: 'openai-default',
    version: 1,
    status: 'accepted',
    description: 'the OpenAI-lane accepted default — byte-identical to the unarmed behaviour',
    compatibility: { providerFamilies: ['openai'], modelFamilies: [], effortLevels: [], requiredCapabilities: [] },
    taskEnvelope: { families: [], complexityBands: [] },
    axes: IDENTITY_AXES_SOLO,
    evidenceRef: 'the accepted policy at bind',
    rollbackProfileId: 'openai-default',
  },
  {
    schema: 1,
    id: 'zai-default',
    version: 1,
    status: 'accepted',
    description: 'the GLM-lane accepted default — byte-identical to the unarmed behaviour',
    compatibility: { providerFamilies: ['zai'], modelFamilies: [], effortLevels: [], requiredCapabilities: [] },
    taskEnvelope: { families: [], complexityBands: [] },
    axes: IDENTITY_AXES_SOLO,
    evidenceRef: 'the accepted policy at bind',
    rollbackProfileId: 'zai-default',
  },
  {
    schema: 1,
    id: 'chat-engine-default',
    // v2: the compatibility row widened to the Hugging Face router and the
    // local servers (both ride this runtime) — a semantic change, bumped
    // deliberately with its frozen digest.
    version: 2,
    status: 'accepted',
    // Provider-08-21: the Moonshot/DeepSeek/compat lanes ride the
    // SAME shared chat-completions runtime; their accepted default is the
    // identity posture (byte-identical harness, solo width) with the
    // families' OWN compatibility — mapping them onto zai-default would
    // decline family-incompatible at resolution (compatibilityDecline).
    description: 'the shared chat-completions lanes\' accepted default (Moonshot · DeepSeek · compat) — byte-identical to the identity posture',
    compatibility: {
      // The fold-seam routes (openrouter/gemini) ride the same IDENTITY
      // posture pre-fold (their runtimes refuse dispatch until the auth lane
      // folds); the auth lane may split family-specific profiles later.
      providerFamilies: ['moonshot', 'deepseek', 'openai-compat', 'openrouter', 'gemini', 'huggingface', 'local'],
      modelFamilies: [],
      effortLevels: [],
      requiredCapabilities: [],
    },
    taskEnvelope: { families: [], complexityBands: [] },
    axes: IDENTITY_AXES_SOLO,
    evidenceRef: 'the accepted policy at bind (identity posture, no measured distinction claimed)',
    rollbackProfileId: 'chat-engine-default',
  },
  {
    schema: 1,
    id: 'anthropic-context-bounded',
    version: 2,
    // The H1a candidate, RETIRED on the first batch's evidence (outcome
    // 'tie'): same-model paired walls indistinguishable (the paired ratio CI
    // [0.39, 1.04] spans 1; GM3 pair 80–83s vs 61–96s), zero acceptance
    // regression on graded runs, zero incorrect claims — and the mechanism
    // is INERT by construction without a published selection budget (no
    // production owner threads `selectionBudget`, so bounded-optional
    // excludes nothing — prove-ch4 §C). A context-mass candidate becomes
    // meaningful only after a budget-publishing owner exists. Retired
    // VISIBLY: this typed status declines every pin NAMED and the selector
    // never picks it; no flags, picker rows, or prompt branches existed.
    status: 'retired',
    description: 'H1a candidate, retired — bounded-optional context measured tie (mechanism inert without a selection budget)',
    compatibility: { providerFamilies: ['anthropic'], modelFamilies: [], effortLevels: [], requiredCapabilities: [] },
    taskEnvelope: { families: [], complexityBands: [] },
    axes: {
      ...IDENTITY_AXES_WIDE,
      context: { selectionPolicy: 'bounded-optional', allocationBand: 'standard' },
    },
    // (The evidence path lives in the record — src never names the benchmark
    // machinery: the bundle-purity law its own suite enforces.)
    evidenceRef: 'the accepted batch policy at bind',
    rollbackProfileId: 'anthropic-default',
  },
]

export const HARNESS_ACCEPTED_DEFAULT_BY_FAMILY: Readonly<Record<CallModelRoute, HarnessProfileId>> = {
  anthropic: 'anthropic-default',
  openai: 'openai-default',
  zai: 'zai-default',
  // Provider-08-21: the shared chat-completions lanes take their
  // OWN accepted identity profile (compatibility declares exactly these
  // families — the zai-default mapping would decline family-incompatible).
  moonshot: 'chat-engine-default',
  deepseek: 'chat-engine-default',
  'openai-compat': 'chat-engine-default',
  openrouter: 'chat-engine-default',
  gemini: 'chat-engine-default',
  huggingface: 'chat-engine-default',
  local: 'chat-engine-default',
}

export function harnessProfileById(id: string): HarnessProfile | null {
  return HARNESS_PROFILES.find(p => p.id === id) ?? null
}

// ── Digests (canonical semantic content; display copy excluded) ─────────────

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']'
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    return '{' + entries.map(([k, v]) => JSON.stringify(k) + ':' + stableStringify(v)).join(',') + '}'
  }
  return JSON.stringify(value)
}

/** The digestable semantic content: everything EXCEPT display copy
 *  (description) — a copy edit must never move a profile digest, an axis or
 *  compatibility change always must. */
function harnessProfileSemanticContent(profile: HarnessProfile): Record<string, unknown> {
  const { description: _display, ...semantic } = profile
  return semantic
}

export function harnessProfileDigest(profile: HarnessProfile): string {
  return 'hpr1-' + createHash('sha256').update(stableStringify(harnessProfileSemanticContent(profile))).digest('hex').slice(0, 16)
}

/** The profile-SET digest — an input to the evidence epoch and the
 *  resolution cache key. */
export function harnessProfileSetDigest(): string {
  return 'hprs1-' + createHash('sha256').update(stableStringify(HARNESS_PROFILES.map(harnessProfileSemanticContent))).digest('hex').slice(0, 16)
}

// ── The evidence epoch ──

/** The architecture identity, bound ONCE here. Harness
 *  evidence minted on a different
 *  architecture cannot govern this one. */
export const CONTINUUM_ARCHITECTURE_IDENTITY = 'continuum-close-3955d8ea'

/** Harness-evidence epoch: architecture estate + identity +
 *  corpus + profile set + grader. Any of these changing retires ALL prior
 *  harness history mechanically (the pe1- pattern: stale outcomes cannot
 *  govern a materially changed harness). Callers pass the LIVE
 *  APEX_ARCHITECTURE_EPOCH from its owner (openaiCatalogue.ts) — this
 *  module composes it and never redefines it. */
export function harnessEvidenceEpoch(inputs: {
  architectureEpoch: string
  corpusDigest: string
  graderDigest: string
}): string {
  return (
    'he1-' +
    createHash('sha256')
      .update(
        inputs.architectureEpoch +
          '|' +
          CONTINUUM_ARCHITECTURE_IDENTITY +
          '|' +
          inputs.corpusDigest +
          '|' +
          harnessProfileSetDigest() +
          '|' +
          inputs.graderDigest,
      )
      .digest('hex')
      .slice(0, 16)
  )
}

// ── Evidence currency (CH-5 — the receiptCurrency pattern) ──────────────────

/** A stored evidence anchor: what a campaign row (or a promotion decision)
 *  was minted against. The COMPONENTS ride along so expiry names its exact
 *  cause instead of an opaque epoch mismatch. */
export interface HarnessEvidenceRef {
  profileId: string
  profileDigest: string
  /** The canonical model id the rows ran on (owner-resolved, never an alias). */
  modelId: string
  architectureEpoch: string
  corpusDigest: string
  graderDigest: string
  evidenceEpoch: string
}

export type HarnessEvidenceCurrency =
  | { current: true; ref: HarnessEvidenceRef }
  | { current: false; ref: HarnessEvidenceRef; expiredBy: string }

/** The requalification alarm (the qualificationStore.receiptCurrency
 *  pattern): evidence is current ONLY while every component it was minted
 *  against still holds — profile alive + digest-identical, the model alias
 *  still resolving to the same canonical id, the architecture epoch, the
 *  corpus, and the composed evidence epoch (which additionally moves on any
 *  profile-SET or grader change). Drift returns a NAMED expiredBy — stale
 *  evidence never silently governs (CH-27/CH-42). Pure: the caller passes
 *  the live facts from their owners. */
export function harnessEvidenceCurrency(
  ref: HarnessEvidenceRef,
  live: { architectureEpoch: string; corpusDigest: string; graderDigest: string; canonicalModelId: string },
): HarnessEvidenceCurrency {
  const profile = harnessProfileById(ref.profileId)
  if (!profile || profile.status === 'retired') {
    return { current: false, ref, expiredBy: `profile '${ref.profileId}' retired or absent from the catalogue` }
  }
  const liveDigest = harnessProfileDigest(profile)
  if (liveDigest !== ref.profileDigest) {
    return { current: false, ref, expiredBy: `profile digest changed (${ref.profileDigest} → ${liveDigest})` }
  }
  if (ref.modelId !== live.canonicalModelId) {
    return { current: false, ref, expiredBy: `model alias moved (${ref.modelId} → ${live.canonicalModelId})` }
  }
  if (ref.architectureEpoch !== live.architectureEpoch) {
    return { current: false, ref, expiredBy: `architecture epoch ${ref.architectureEpoch} ≠ ${live.architectureEpoch}` }
  }
  if (ref.corpusDigest !== live.corpusDigest) {
    return { current: false, ref, expiredBy: `corpus digest changed (${ref.corpusDigest} → ${live.corpusDigest})` }
  }
  const liveEpoch = harnessEvidenceEpoch({
    architectureEpoch: live.architectureEpoch,
    corpusDigest: live.corpusDigest,
    graderDigest: live.graderDigest,
  })
  if (ref.evidenceEpoch !== liveEpoch) {
    return {
      current: false,
      ref,
      expiredBy: `evidence epoch drifted (${ref.evidenceEpoch} → ${liveEpoch} — a profile-set or grader change)`,
    }
  }
  return { current: true, ref }
}

// ── The total decoder (schema-versioned, unknown-field-tolerant) ────────────

export type HarnessProfileDecodeResult =
  | { ok: true; profile: HarnessProfile; unknownFields: readonly string[] }
  | { ok: false; error: string }

const KNOWN_TOP_FIELDS = new Set([
  'schema',
  'id',
  'version',
  'status',
  'description',
  'compatibility',
  'taskEnvelope',
  'axes',
  'evidenceRef',
  'rollbackProfileId',
])
const KNOWN_AXES = new Set([
  'context',
  'toolPresentation',
  'editingPosture',
  'verificationPosture',
  'delegationTopology',
  'turnRecovery',
])
const STATUS_VALUES = new Set<HarnessProfileStatus>(['candidate', 'qualified', 'accepted', 'retired'])

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every(x => typeof x === 'string')
}

/** TOTAL: never throws. Unknown fields (top-level and axis-level) are
 *  tolerated and REPORTED — a future schema-1 producer may add fields; a
 *  reader this old maps what it knows and names what it does not. A
 *  different schema number is a typed error: decoder support precedes any
 *  schema change (the ratified contract law). */
export function decodeHarnessProfile(value: unknown): HarnessProfileDecodeResult {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, error: 'not-an-object' }
  }
  const raw = value as Record<string, unknown>
  if (raw.schema !== 1) return { ok: false, error: `unsupported-schema:${String(raw.schema)}` }
  if (typeof raw.id !== 'string' || raw.id.length === 0) return { ok: false, error: 'missing-id' }
  if (typeof raw.version !== 'number' || !Number.isInteger(raw.version) || raw.version < 1) {
    return { ok: false, error: 'missing-version' }
  }
  if (typeof raw.status !== 'string' || !STATUS_VALUES.has(raw.status as HarnessProfileStatus)) {
    return { ok: false, error: `unknown-status:${String(raw.status)}` }
  }
  if (typeof raw.description !== 'string') return { ok: false, error: 'missing-description' }
  if (typeof raw.rollbackProfileId !== 'string' || raw.rollbackProfileId.length === 0) {
    return { ok: false, error: 'missing-rollbackProfileId' }
  }
  const compat = raw.compatibility as Record<string, unknown> | undefined
  if (
    compat === null ||
    typeof compat !== 'object' ||
    !isStringArray(compat.providerFamilies) ||
    !isStringArray(compat.modelFamilies) ||
    !isStringArray(compat.effortLevels) ||
    !isStringArray(compat.requiredCapabilities)
  ) {
    return { ok: false, error: 'malformed-compatibility' }
  }
  const envelope = raw.taskEnvelope as Record<string, unknown> | undefined
  if (
    envelope === null ||
    typeof envelope !== 'object' ||
    !isStringArray(envelope.families) ||
    !isStringArray(envelope.complexityBands)
  ) {
    return { ok: false, error: 'malformed-taskEnvelope' }
  }
  const axes = raw.axes as Record<string, unknown> | undefined
  if (axes === null || typeof axes !== 'object') return { ok: false, error: 'malformed-axes' }
  if (raw.evidenceRef !== undefined && typeof raw.evidenceRef !== 'string') {
    return { ok: false, error: 'malformed-evidenceRef' }
  }

  const unknownFields: string[] = []
  for (const k of Object.keys(raw)) if (!KNOWN_TOP_FIELDS.has(k)) unknownFields.push(k)
  for (const k of Object.keys(axes)) if (!KNOWN_AXES.has(k)) unknownFields.push('axes.' + k)

  // Structural acceptance is the decoder's job; whether every axis STATE is
  // a known owner-published value is the catalogue's and the application
  // layer's job (unknown states map to the owner default and stay visible
  // here as unknown fields when their key is new).
  return { ok: true, profile: raw as unknown as HarnessProfile, unknownFields }
}

// ── The resolver (pure, deterministic, cached) ──────────────────────────────

export const HARNESS_REASON_CODES = [
  'session-pin-wins',
  'persisted-pin-wins',
  'pin-unknown-fallthrough',
  'pin-incompatible-fallthrough',
  'pin-unavailable-fallthrough',
  'selector-qualified-history',
  'no-qualified-candidate',
  'unknown-model-conservative-default',
  'no-catalogue-candidate-fallback',
  'family-incompatible',
  'effort-incompatible',
  'effort-fact-absent',
  'capability-missing',
  'model-family-incompatible',
  'status-not-selectable',
  'history-insufficient',
  'history-epoch-mismatch-ignored',
  'history-low-sample-ignored',
  'history-not-better',
] as const
export type HarnessReasonCode = (typeof HARNESS_REASON_CODES)[number]

export interface HarnessModelFacts {
  /** From classifyModelRoute — never from display copy. 'unrecognised' is
   *  the honest stamp for an id no family declares (never a borrowed
   *  family); absence never reaches this seam — the application layer's
   *  'best' arm resolves it first. */
  providerFamily: CallModelRoute | 'unrecognised'
  modelId: string
  /** Family label derived by the application layer from the owning
   *  catalogues (the model registry / provider catalogues). */
  modelFamily: string
  effortLevel: EffortLevel | null
  /** False when the model id is absent from every owning catalogue/alias —
   *  the CH-14 conservative-default trigger. */
  modelKnown: boolean
  capabilities: readonly string[]
}

export interface HarnessHistoryStats {
  profileId: string
  epoch: string
  sampleCount: number
  /** Execution-verified accepted rate for (profile, facts) in that epoch. */
  acceptedRate: number
}

export interface HarnessResolutionInputs {
  /** Validated upstream only for SHAPE; validity against the catalogue is
   *  this resolver's job (invalid pins fall through, named). */
  sessionPin: string | null
  persistedPin: string | null
  facts: HarnessModelFacts
  /** Digest from the owning task-facts producers (project intel / the router); null =
   *  no task facts in scope. */
  taskFactsDigest: string | null
  /** From harnessEvidenceEpoch — epoch-scoped history only. */
  evidenceEpoch: string
  history: readonly HarnessHistoryStats[]
}

export interface HarnessProfileResolution {
  profileId: HarnessProfileId
  profileDigest: string
  origin: 'session-pin' | 'persisted-pin' | 'selector' | 'accepted-default'
  /** Ordered trail; [0] is the primary reason every surface projects. */
  reasonCodes: readonly HarnessReasonCode[]
  declined: readonly { profileId: string; reason: HarnessReasonCode }[]
  evidenceEpoch: string
  factsDigest: string
}

/** The resolution facts digest — the cache key half and the receipt field
 *  (CH-10): pins + model facts + task-facts digest + epoch + history rows. */
export function harnessFactsDigest(inputs: HarnessResolutionInputs): string {
  return (
    'hf1-' +
    createHash('sha256')
      .update(
        stableStringify({
          sessionPin: inputs.sessionPin,
          persistedPin: inputs.persistedPin,
          facts: inputs.facts,
          taskFactsDigest: inputs.taskFactsDigest,
          evidenceEpoch: inputs.evidenceEpoch,
          history: inputs.history,
        }),
      )
      .digest('hex')
      .slice(0, 16)
  )
}

function compatibilityDecline(profile: HarnessProfile, facts: HarnessModelFacts): HarnessReasonCode | null {
  // A stranger family is compatible with no profile: no profile declares
  // compatibility with an id nobody declares.
  if (facts.providerFamily === 'unrecognised' || !profile.compatibility.providerFamilies.includes(facts.providerFamily)) return 'family-incompatible'
  if (profile.compatibility.modelFamilies.length > 0 && !profile.compatibility.modelFamilies.includes(facts.modelFamily)) {
    return 'model-family-incompatible'
  }
  // The effort axis judges the effort FACT — the tier the request carries,
  // from the one effort owner (harnessApplication.harnessEffortFact at
  // every boundary). An absent fact (a model with no effort control, a wire
  // that omits the key) declines under its own code, never as a mismatch
  // (FN-018 rank 24: the axis used to be undecidable because no live caller
  // supplied the fact, and the decline misstated the cause).
  if (profile.compatibility.effortLevels.length > 0) {
    if (facts.effortLevel === null) return 'effort-fact-absent'
    if (!profile.compatibility.effortLevels.includes(facts.effortLevel)) return 'effort-incompatible'
  }
  if (profile.compatibility.requiredCapabilities.some(c => !facts.capabilities.includes(c))) {
    return 'capability-missing'
  }
  return null
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const v of Object.values(value as Record<string, unknown>)) deepFreeze(v)
    Object.freeze(value)
  }
  return value
}

/** The PURE resolver. Deterministic for identical inputs; every considered
 *  profile that is not selected lands in declined[] with a named reason. */
export function resolveHarnessProfile(inputs: HarnessResolutionInputs): HarnessProfileResolution {
  const factsDigest = harnessFactsDigest(inputs)
  const declined: { profileId: string; reason: HarnessReasonCode }[] = []
  const finish = (
    profile: HarnessProfile,
    origin: HarnessProfileResolution['origin'],
    reasonCodes: HarnessReasonCode[],
  ): HarnessProfileResolution =>
    deepFreeze({
      profileId: profile.id,
      profileDigest: harnessProfileDigest(profile),
      origin,
      reasonCodes,
      declined,
      evidenceEpoch: inputs.evidenceEpoch,
      factsDigest,
    })

  // 1 · pins (session > persisted). Invalid pins fall through, NAMED —
  //     never a silent substitute (invariant 7).
  const pinTiers: Array<{
    pin: string | null
    origin: 'session-pin' | 'persisted-pin'
    winReason: HarnessReasonCode
    pinnableStatuses: readonly HarnessProfileStatus[]
  }> = [
    // A session pin is the operator's (and the campaign harness's) explicit
    // live instrument — it may select dev candidates; durable persisted
    // pins may not.
    { pin: inputs.sessionPin, origin: 'session-pin', winReason: 'session-pin-wins', pinnableStatuses: ['candidate', 'qualified', 'accepted'] },
    { pin: inputs.persistedPin, origin: 'persisted-pin', winReason: 'persisted-pin-wins', pinnableStatuses: ['qualified', 'accepted'] },
  ]
  for (const tier of pinTiers) {
    if (tier.pin === null) continue
    const pinned = harnessProfileById(tier.pin)
    if (!pinned) {
      declined.push({ profileId: tier.pin, reason: 'pin-unknown-fallthrough' })
      continue
    }
    if (!tier.pinnableStatuses.includes(pinned.status)) {
      declined.push({ profileId: pinned.id, reason: 'pin-unavailable-fallthrough' })
      continue
    }
    const incompat = compatibilityDecline(pinned, inputs.facts)
    if (incompat !== null) {
      declined.push({ profileId: pinned.id, reason: 'pin-incompatible-fallthrough' })
      continue
    }
    return finish(pinned, tier.origin, [tier.winReason])
  }

  // An unrecognised family holds NO accepted default (nothing is borrowed
  // from the home lane) — the stranger road ends at the guarded total
  // fallback below.
  const familyDefault =
    inputs.facts.providerFamily === 'unrecognised'
      ? undefined
      : harnessProfileById(HARNESS_ACCEPTED_DEFAULT_BY_FAMILY[inputs.facts.providerFamily])

  // 2 · an unknown model never routes on history — the named conservative
  //     default (CH-14).
  if (!inputs.facts.modelKnown) {
    if (familyDefault) return finish(familyDefault, 'accepted-default', ['unknown-model-conservative-default'])
  }

  // 3 · the qualified selector: only status-qualified, compatibility-
  //     eligible candidates, and only on epoch-current, sample-floored,
  //     measurably-better history against the family default's own floored
  //     baseline. Indistinguishable ⇒ the simpler accepted default.
  if (inputs.facts.modelKnown && familyDefault) {
    const statsFor = (id: string): { stats: HarnessHistoryStats | null; ignore: HarnessReasonCode | null } => {
      const row = inputs.history.find(h => h.profileId === id) ?? null
      if (!row) return { stats: null, ignore: null }
      if (row.epoch !== inputs.evidenceEpoch) return { stats: null, ignore: 'history-epoch-mismatch-ignored' }
      if (row.sampleCount < OUTCOME_MIN_SAMPLES) return { stats: null, ignore: 'history-low-sample-ignored' }
      return { stats: row, ignore: null }
    }
    const baseline = statsFor(familyDefault.id)
    let winner: { profile: HarnessProfile; rate: number } | null = null
    for (const candidate of HARNESS_PROFILES) {
      if (candidate.id === familyDefault.id) continue
      if (candidate.status !== 'qualified') {
        if (candidate.status === 'candidate' || candidate.status === 'retired') {
          declined.push({ profileId: candidate.id, reason: 'status-not-selectable' })
        }
        continue
      }
      const incompat = compatibilityDecline(candidate, inputs.facts)
      if (incompat !== null) {
        declined.push({ profileId: candidate.id, reason: incompat })
        continue
      }
      const own = statsFor(candidate.id)
      if (own.ignore !== null) {
        declined.push({ profileId: candidate.id, reason: own.ignore })
        continue
      }
      if (own.stats === null || baseline.stats === null) {
        declined.push({ profileId: candidate.id, reason: 'history-insufficient' })
        continue
      }
      if (own.stats.acceptedRate <= baseline.stats.acceptedRate) {
        declined.push({ profileId: candidate.id, reason: 'history-not-better' })
        continue
      }
      if (winner === null || own.stats.acceptedRate > winner.rate) {
        if (winner !== null) declined.push({ profileId: winner.profile.id, reason: 'history-not-better' })
        winner = { profile: candidate, rate: own.stats.acceptedRate }
      } else {
        declined.push({ profileId: candidate.id, reason: 'history-not-better' })
      }
    }
    if (winner !== null) {
      const reasons: HarnessReasonCode[] = ['selector-qualified-history']
      if (baseline.ignore !== null) reasons.push(baseline.ignore)
      return finish(winner.profile, 'selector', reasons)
    }
  }

  // 4 · the accepted default of the provider family.
  if (familyDefault) {
    return finish(familyDefault, 'accepted-default', [
      inputs.facts.modelKnown ? 'no-qualified-candidate' : 'unknown-model-conservative-default',
    ])
  }

  // 5 · total fallback — the stranger road's landing (an unrecognised
  //     family holds no accepted default), and the totality guard for a
  //     declared family over future catalogue edits.
  const anyAccepted = HARNESS_PROFILES.find(p => p.status === 'accepted')
  if (!anyAccepted) throw new Error('harness catalogue invariant broken: no accepted profile')
  return finish(anyAccepted, 'accepted-default', ['no-catalogue-candidate-fallback'])
}

// ── The bounded resolution cache (CH-28: O(1) steady state) ─────────────────

const RESOLUTION_CACHE_CAP = 64
const resolutionCache = new Map<string, HarnessProfileResolution>()
let resolveComputeCount = 0

/** Proof instrument: how many times
 *  the pure resolver actually computed. */
export function _harnessResolveComputeCount(): number {
  return resolveComputeCount
}

/** Cached resolution — keyed by facts digest + set digest, so a model
 *  transition, owner-generation change (via the epoch/facts), pin change,
 *  or profile-set change re-computes, and everything else is a lookup. */
export function resolveHarnessProfileCached(inputs: HarnessResolutionInputs): HarnessProfileResolution {
  const key = harnessFactsDigest(inputs) + '|' + harnessProfileSetDigest()
  const hit = resolutionCache.get(key)
  if (hit) return hit
  resolveComputeCount++
  const resolution = resolveHarnessProfile(inputs)
  if (resolutionCache.size >= RESOLUTION_CACHE_CAP) {
    const oldest = resolutionCache.keys().next()
    if (!oldest.done) resolutionCache.delete(oldest.value)
  }
  resolutionCache.set(key, resolution)
  return resolution
}
