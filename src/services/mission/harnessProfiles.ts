
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

export const HARNESS_MAX_QUALIFIED_POSTURES = 8

export type HarnessProfileStatus = 'candidate' | 'qualified' | 'accepted' | 'retired'

export interface HarnessProfileAxes {
  context: {
    selectionPolicy: ContextPolicyClass
    allocationBand: 'standard' | 'lean' | 'rich'
  }
  toolPresentation: {
    catalogue: 'standard' | 'grouped-compact'
    parallelCalls: 'provider-default' | 'discouraged'
  }
  editingPosture: {
    preference: 'owner-default' | 'anchored-single' | 'multi-hunk' | 'changeset'
  }
  verificationPosture: {
    focusedCadence: 'standard' | 'sparse' | 'dense'
    reviewerBand: 'mission-owned' | 'on-completion-supported' | 'none-supported'
  }
  delegationTopology: {
    supportedExecution: readonly ('solo' | 'routed' | 'workflow')[]
    maxConcurrentLanes: 1 | 2 | 3
  }
  turnRecovery: {
    timeoutClass: 'standard' | 'extended'
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
    modelFamilies: readonly string[]
    effortLevels: readonly EffortLevel[]
    requiredCapabilities: readonly string[]
  }
  taskEnvelope: {
    families: readonly RouteTaskShape[]
    complexityBands: readonly string[]
  }
  axes: HarnessProfileAxes
  evidenceRef?: string
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
    version: 2,
    status: 'accepted',
    description: 'the shared chat-completions lanes\' accepted default (Moonshot · DeepSeek · compat) — byte-identical to the identity posture',
    compatibility: {
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
    status: 'retired',
    description: 'H1a candidate, retired — bounded-optional context measured tie (mechanism inert without a selection budget)',
    compatibility: { providerFamilies: ['anthropic'], modelFamilies: [], effortLevels: [], requiredCapabilities: [] },
    taskEnvelope: { families: [], complexityBands: [] },
    axes: {
      ...IDENTITY_AXES_WIDE,
      context: { selectionPolicy: 'bounded-optional', allocationBand: 'standard' },
    },
    evidenceRef: 'the accepted batch policy at bind',
    rollbackProfileId: 'anthropic-default',
  },
]

export const HARNESS_ACCEPTED_DEFAULT_BY_FAMILY: Readonly<Record<CallModelRoute, HarnessProfileId>> = {
  anthropic: 'anthropic-default',
  openai: 'openai-default',
  zai: 'zai-default',
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

function harnessProfileSemanticContent(profile: HarnessProfile): Record<string, unknown> {
  const { description: _display, ...semantic } = profile
  return semantic
}

export function harnessProfileDigest(profile: HarnessProfile): string {
  return 'hpr1-' + createHash('sha256').update(stableStringify(harnessProfileSemanticContent(profile))).digest('hex').slice(0, 16)
}

export function harnessProfileSetDigest(): string {
  return 'hprs1-' + createHash('sha256').update(stableStringify(HARNESS_PROFILES.map(harnessProfileSemanticContent))).digest('hex').slice(0, 16)
}


export const CONTINUUM_ARCHITECTURE_IDENTITY = 'continuum-close-3955d8ea'

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


export interface HarnessEvidenceRef {
  profileId: string
  profileDigest: string
  modelId: string
  architectureEpoch: string
  corpusDigest: string
  graderDigest: string
  evidenceEpoch: string
}

export type HarnessEvidenceCurrency =
  | { current: true; ref: HarnessEvidenceRef }
  | { current: false; ref: HarnessEvidenceRef; expiredBy: string }

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

  return { ok: true, profile: raw as unknown as HarnessProfile, unknownFields }
}


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
  providerFamily: CallModelRoute | 'unrecognised'
  modelId: string
  modelFamily: string
  effortLevel: EffortLevel | null
  modelKnown: boolean
  capabilities: readonly string[]
}

export interface HarnessHistoryStats {
  profileId: string
  epoch: string
  sampleCount: number
  acceptedRate: number
}

export interface HarnessResolutionInputs {
  sessionPin: string | null
  persistedPin: string | null
  facts: HarnessModelFacts
  taskFactsDigest: string | null
  evidenceEpoch: string
  history: readonly HarnessHistoryStats[]
}

export interface HarnessProfileResolution {
  profileId: HarnessProfileId
  profileDigest: string
  origin: 'session-pin' | 'persisted-pin' | 'selector' | 'accepted-default'
  reasonCodes: readonly HarnessReasonCode[]
  declined: readonly { profileId: string; reason: HarnessReasonCode }[]
  evidenceEpoch: string
  factsDigest: string
}

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
  if (facts.providerFamily === 'unrecognised' || !profile.compatibility.providerFamilies.includes(facts.providerFamily)) return 'family-incompatible'
  if (profile.compatibility.modelFamilies.length > 0 && !profile.compatibility.modelFamilies.includes(facts.modelFamily)) {
    return 'model-family-incompatible'
  }
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

  const pinTiers: Array<{
    pin: string | null
    origin: 'session-pin' | 'persisted-pin'
    winReason: HarnessReasonCode
    pinnableStatuses: readonly HarnessProfileStatus[]
  }> = [
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

  const familyDefault =
    inputs.facts.providerFamily === 'unrecognised'
      ? undefined
      : harnessProfileById(HARNESS_ACCEPTED_DEFAULT_BY_FAMILY[inputs.facts.providerFamily])

  if (!inputs.facts.modelKnown) {
    if (familyDefault) return finish(familyDefault, 'accepted-default', ['unknown-model-conservative-default'])
  }

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

  if (familyDefault) {
    return finish(familyDefault, 'accepted-default', [
      inputs.facts.modelKnown ? 'no-qualified-candidate' : 'unknown-model-conservative-default',
    ])
  }

  const anyAccepted = HARNESS_PROFILES.find(p => p.status === 'accepted')
  if (!anyAccepted) throw new Error('harness catalogue invariant broken: no accepted profile')
  return finish(anyAccepted, 'accepted-default', ['no-catalogue-candidate-fallback'])
}


const RESOLUTION_CACHE_CAP = 64
const resolutionCache = new Map<string, HarnessProfileResolution>()
let resolveComputeCount = 0

export function _harnessResolveComputeCount(): number {
  return resolveComputeCount
}

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
