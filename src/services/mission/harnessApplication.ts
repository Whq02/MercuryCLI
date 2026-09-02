// ============================================================================
//  services/mission/harnessApplication — the harness-profile application layer.
//
//  THE one gated entry between the pure HarnessProfile owner
//  (harnessProfiles.ts) and the live session: builds model facts from the
//  OWNING resolvers (never display labels), resolves the active
//  profile through the cached pure resolver, and keeps a bounded in-memory
//  boundary-receipt ring. No writer, planner, scorer, store, or prompt fork
//  of its own; no prompt bytes anywhere (CH-17 — the composer never imports
//  this module).
//
//  THE FLAG GATE (CH-41): `MERCURY_HARNESS_PROFILE` unset/off ⇒ every entry
//  returns null WITHOUT touching the resolver — zero resolution work, zero
//  receipts, behavior byte-identical (the registry `off` contract). The gate
//  re-reads the registered env LIVE on every call (the authority-toggle
//  law). `MERCURY_HARNESS_PROFILE_PIN` is the session-pin carrier (the
//  campaign/dev instrument), read only while armed; invalid pins fall
//  through NAMED at the resolver, never silently.
//
//  Boundaries (CH-2): the main-loop model slot (session start + every
//  settlement — the REPL A04 effect) and subagent spawn (AgentTool). Each
//  boundary calls ONE entry with the model string its owner already
//  resolved; the facts-keyed cache makes "resolve once per change"
//  mechanical (a boundary crossing changes the facts digest ⇒ exactly one
//  recompute — CH-28's O(1) steady state).
// ============================================================================

import { flagEnv } from '../../substrate/flagRegistry.js'
import { getGlobalConfig } from '../../utils/config.js'
import { resolveEffortTruth, type EffortValue } from '../../utils/effort.js'
import { APEX_ARCHITECTURE_EPOCH, getCachedOpenaiCatalogue } from '../providers/openai/openaiCatalogue.js'
import { classifyModelRoute } from '../providers/callModelRouter.js'
import { getPublicModelDisplayName, normalizeModelStringForAPI, parseUserSpecifiedModel } from '../../utils/model/model.js'
import {
  harnessEvidenceEpoch,
  harnessProfileById,
  resolveHarnessProfileCached,
  type HarnessModelFacts,
  type HarnessProfileResolution,
  type HarnessReasonCode,
} from './harnessProfiles.js'
import type { EffortLevel } from '../../utils/effort.js'
import type { ContextPolicyClass } from '../run/contextSelection.js'

const TRUTHY = new Set(['1', 'true', 'yes', 'on'])

/** LIVE flag read — armed only while the registered flag says so. */
export function harnessProfileArmed(): boolean {
  return TRUTHY.has((flagEnv('MERCURY_HARNESS_PROFILE') ?? '').toLowerCase())
}

// ── Session pin (CH-3): the in-app slot ≻ the env carrier ───────────────────
// The /harness view sets the slot; the env pin (MERCURY_HARNESS_PROFILE_PIN)
// stays the campaign/headless instrument. Session-scoped, never persisted —
// the durable operator pin is the config owner's `harnessProfilePin` key.
let sessionPinSlot: string | null = null

export function setHarnessSessionPin(id: string | null): void {
  sessionPinSlot = id
}

export function harnessSessionPin(): string | null {
  return sessionPinSlot ?? ((flagEnv('MERCURY_HARNESS_PROFILE_PIN') ?? '').trim() || null)
}

/** The first-party model families the home lane recognizes (the id shape is
 *  `<vendor>-<family>-<n>`; the family token is segment 2 of the CANONICAL
 *  owner-resolved id — never display copy). */
const HOME_MODEL_FAMILIES = new Set(['fable', 'mythos', 'opus', 'sonnet', 'haiku'])

/** Model facts from the OWNING resolvers (CH-09):
 *  · canonical id via parseUserSpecifiedModel (the /model text-path owner —
 *    aliases resolve exactly as the picker resolves them; null ⇒ the
 *    owner's own 'best' answer) + normalizeModelStringForAPI;
 *  · provider family via classifyModelRoute (the routing law's honest
 *    verdict; an id no family declares stamps 'unrecognised', never the
 *    home lane's identity — absence never reaches the classifier, the
 *    'best' arm above resolves it first);
 *  · knownness via the catalogue owners — home lane: the public display
 *    catalogue + the future-model catalogue; openai: the CACHED live
 *    catalogue (a cold cache reads as unknown — conservative and honest;
 *    this entry never kicks a refresh); zai: the router's own GLM prefix
 *    law IS that lane's catalogue.
 */
export function buildHarnessModelFacts(
  model: string | null | undefined,
  effortLevel?: EffortLevel | null,
): HarnessModelFacts {
  const canonical = parseUserSpecifiedModel(model === null || model === undefined || model.trim() === '' ? 'best' : model)
  const normalized = normalizeModelStringForAPI(canonical).trim().toLowerCase()
  const bare = normalized.replace(/\[1m\]$/i, '')
  const routeVerdict = classifyModelRoute(normalized)
  const providerFamily: HarnessModelFacts['providerFamily'] =
    routeVerdict.kind === 'route' ? routeVerdict.route : 'unrecognised'
  let modelFamily = ''
  let modelKnown = false
  if (providerFamily === 'openai') {
    modelFamily = 'gpt'
    modelKnown = (['chatgpt-subscription', 'api-key'] as const).some(kind =>
      getCachedOpenaiCatalogue(kind)?.models.some(m => m.id.toLowerCase() === bare),
    )
  } else if (providerFamily === 'zai') {
    modelFamily = 'glm'
    modelKnown = bare.startsWith('glm')
  } else if (providerFamily === 'moonshot') {
    // Provider-08-21: knownness from the lane's dated pins (no
    // live catalogue is documented for this lane).
    modelFamily = 'kimi'
    modelKnown = ((): boolean => {
      const { kimiDisplayPin } =
        require('../providers/moonshot/kimiPins.js') as typeof import('../providers/moonshot/kimiPins.js')
      return kimiDisplayPin(bare) !== undefined
    })()
  } else if (providerFamily === 'deepseek') {
    modelFamily = 'deepseek'
    modelKnown = ((): boolean => {
      const { deepseekDisplayPin } =
        require('../providers/deepseek/deepseekPins.js') as typeof import('../providers/deepseek/deepseekPins.js')
      return deepseekDisplayPin(bare) !== undefined
    })()
  } else if (providerFamily === 'openai-compat') {
    // The compat slot's models are operator-named — the operator's list IS
    // that lane's catalogue (an unlisted compat/<id> stays conservative).
    modelFamily = 'compat'
    modelKnown = ((): boolean => {
      const { compatSlotModelIds } =
        require('../providers/openaicompat/compatAccounts.js') as typeof import('../providers/openaicompat/compatAccounts.js')
      return compatSlotModelIds().includes(bare)
    })()
  } else {
    const familyToken = bare.split('-')[1] ?? ''
    modelFamily = HOME_MODEL_FAMILIES.has(familyToken) ? familyToken : ''
    modelKnown = getPublicModelDisplayName(bare) !== null
  }
  return {
    providerFamily,
    modelId: bare,
    modelFamily,
    effortLevel: effortLevel ?? null,
    modelKnown,
    // No accepted/qualified profile requires a capability yet; the owning
    // capability resolvers join here the moment one does.
    capabilities: [],
  }
}

/** The evidence epoch for live (non-campaign) resolution: the constant
 *  composed with the no-campaign corpus/grader markers. Campaign rows mint
 *  their own epochs with real corpus/grader digests (CH-4). Constant per
 *  process, computed lazily
 *  once. */
let liveEpochMemo: string | null = null
export function liveHarnessEvidenceEpoch(): string {
  liveEpochMemo ??= harnessEvidenceEpoch({
    architectureEpoch: APEX_ARCHITECTURE_EPOCH,
    corpusDigest: 'none',
    graderDigest: 'none',
  })
  return liveEpochMemo
}

/** The effort FACT for the harness axis, from the ONE effort owner: the
 *  tier the request will carry for `model` under the session's effort
 *  value — null when the model has no effort control or its wire omits the
 *  key. The profiles' effort axis was declared against a fact no boundary
 *  supplied (FN-018 rank 24); every boundary derives it here now, from the
 *  same resolution the wire uses. */
export function harnessEffortFact(
  model: string | null | undefined,
  sessionEffortValue: EffortValue | undefined,
): EffortLevel | null {
  if (model === null || model === undefined || model.trim() === '') return null
  return resolveEffortTruth(model, sessionEffortValue).applied ?? null
}

/** THE gated resolution entry. Off ⇒ null with ZERO resolver work (CH-41).
 *  Armed ⇒ the cached pure resolution for the live facts (persisted pins
 *  join at CH-3 with the operator surface; history joins with the CH-4/5
 *  evidence stores). */
export function resolveActiveHarnessProfile(opts: {
  model: string | null | undefined
  effortLevel?: EffortLevel | null
  taskFactsDigest?: string | null
}): HarnessProfileResolution | null {
  if (!harnessProfileArmed()) return null
  // The durable operator pin rides the config owner (CH-3); shape-invalid
  // and unknown values fall through NAMED at the resolver, never silently.
  const persistedPin = (getGlobalConfig().harnessProfilePin ?? '').trim() || null
  return resolveHarnessProfileCached({
    sessionPin: harnessSessionPin(),
    persistedPin,
    facts: buildHarnessModelFacts(opts.model, opts.effortLevel),
    taskFactsDigest: opts.taskFactsDigest ?? null,
    evidenceEpoch: liveHarnessEvidenceEpoch(),
    history: [],
  })
}

/** The CH-4 context-axis application: the active profile's owner-published
 *  selection-policy REQUEST, consumed by `resolveSelectionPolicy` at the ONE
 *  builder (`buildRequestContextPlan` step 0 — the live request AND
 *  `/context` thread it identically, keeping the parity oracle whole).
 *  The explicit `MERCURY_CONTEXT_SELECTION` flag OUTRANKS the request
 *  (operator choice wins). Off ⇒ null with zero resolver work; the accepted
 *  defaults request 'preserve-all' — armed-default behaviour stays
 *  byte-identical (the CH-15 certificate). */
export function harnessContextPolicyRequest(
  model: string | null | undefined,
  sessionEffortValue?: EffortValue,
): ContextPolicyClass | null {
  const resolution = resolveActiveHarnessProfile({ model, effortLevel: harnessEffortFact(model, sessionEffortValue) })
  if (!resolution) return null
  return harnessProfileById(resolution.profileId)?.axes.context.selectionPolicy ?? null
}

// ── The bounded boundary-receipt ring (the one receipt seed, CH-2) ──────────

export interface HarnessBoundaryReceipt {
  boundary: 'main-loop' | 'subagent-spawn'
  model: string
  profileId: string
  profileDigest: string
  origin: HarnessProfileResolution['origin']
  reasonCode: HarnessReasonCode
  factsDigest: string
  evidenceEpoch: string
  at: number
}

const RECEIPT_RING_CAP = 32
const receiptRing: HarnessBoundaryReceipt[] = []
let lastMainLoopFactsDigest: string | null = null

/** Note a boundary crossing. Off ⇒ null, zero work. Armed ⇒ resolve (cache
 *  makes repeats O(1)) and append a receipt — main-loop appends only when
 *  the resolution actually moved (mount + every settlement that changes the
 *  facts); every subagent spawn appends (each spawn is its own boundary). */
export function noteHarnessBoundary(
  boundary: HarnessBoundaryReceipt['boundary'],
  model: string | null | undefined,
  effortLevel?: EffortLevel | null,
): HarnessProfileResolution | null {
  const resolution = resolveActiveHarnessProfile({ model, effortLevel })
  if (!resolution) return null
  if (boundary === 'main-loop') {
    if (resolution.factsDigest === lastMainLoopFactsDigest) return resolution
    lastMainLoopFactsDigest = resolution.factsDigest
  }
  receiptRing.push({
    boundary,
    model: buildHarnessModelFacts(model, effortLevel).modelId,
    profileId: resolution.profileId,
    profileDigest: resolution.profileDigest,
    origin: resolution.origin,
    reasonCode: resolution.reasonCodes[0]!,
    factsDigest: resolution.factsDigest,
    evidenceEpoch: resolution.evidenceEpoch,
    at: Date.now(),
  })
  if (receiptRing.length > RECEIPT_RING_CAP) receiptRing.shift()
  return resolution
}

/** Read-only ring view (surfaces + provers). */
export function harnessBoundaryReceipts(): readonly HarnessBoundaryReceipt[] {
  return receiptRing
}
