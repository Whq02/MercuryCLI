
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

export function harnessProfileArmed(): boolean {
  return TRUTHY.has((flagEnv('MERCURY_HARNESS_PROFILE') ?? '').toLowerCase())
}

let sessionPinSlot: string | null = null

export function setHarnessSessionPin(id: string | null): void {
  sessionPinSlot = id
}

export function harnessSessionPin(): string | null {
  return sessionPinSlot ?? ((flagEnv('MERCURY_HARNESS_PROFILE_PIN') ?? '').trim() || null)
}

const HOME_MODEL_FAMILIES = new Set(['fable', 'mythos', 'opus', 'sonnet', 'haiku'])

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
    capabilities: [],
  }
}

let liveEpochMemo: string | null = null
export function liveHarnessEvidenceEpoch(): string {
  liveEpochMemo ??= harnessEvidenceEpoch({
    architectureEpoch: APEX_ARCHITECTURE_EPOCH,
    corpusDigest: 'none',
    graderDigest: 'none',
  })
  return liveEpochMemo
}

export function harnessEffortFact(
  model: string | null | undefined,
  sessionEffortValue: EffortValue | undefined,
): EffortLevel | null {
  if (model === null || model === undefined || model.trim() === '') return null
  return resolveEffortTruth(model, sessionEffortValue).applied ?? null
}

export function resolveActiveHarnessProfile(opts: {
  model: string | null | undefined
  effortLevel?: EffortLevel | null
  taskFactsDigest?: string | null
}): HarnessProfileResolution | null {
  if (!harnessProfileArmed()) return null
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

export function harnessContextPolicyRequest(
  model: string | null | undefined,
  sessionEffortValue?: EffortValue,
): ContextPolicyClass | null {
  const resolution = resolveActiveHarnessProfile({ model, effortLevel: harnessEffortFact(model, sessionEffortValue) })
  if (!resolution) return null
  return harnessProfileById(resolution.profileId)?.axes.context.selectionPolicy ?? null
}


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

export function harnessBoundaryReceipts(): readonly HarnessBoundaryReceipt[] {
  return receiptRing
}
