import type { Options } from '../../anthropic/streamCore.js'
import {
  type OpenaiRequestAuth,
} from '../openaiAccounts.js'
import {
  liveGptEffortCatalogue,
  liveGptListedEffortWords,
  resolveGptReasoningProfile,
  type GptCandidate,
  type GptReasoningProfile,
} from '../openaiCatalogue.js'
import { describeWireEffortProbeWindow } from '../qualificationStore.js'
import { resolveEffortTruth, resolveWireRequestedEffort, type EffortAdjustedV1, type EffortValue } from '../../../effort/effort.js'
import { floorEffort } from '../../../catalogue/utilityModel.js'
import { getPublicModelDisplayName } from '../../../catalogue/engineModel.js'

export function resolveTurnEffort(modelId: string, candidate: GptCandidate | undefined, options: Options, auth: OpenaiRequestAuth) {
  const kept = candidate === undefined ? liveGptEffortCatalogue(modelId) : undefined
  const remembered = kept !== undefined && kept.vocabulary.length > 0 ? kept : undefined
  const effortContext = { agentId: options.agentId, pinned: options.effortPinned === true }
  const servedEfforts = candidate?.live.supportedReasoningEfforts ?? remembered?.vocabulary ?? []
  const floorWanted = options.effortPinned === true && options.effortValue === undefined && servedEfforts.length > 0
  const effortValue = floorWanted ? (floorEffort(servedEfforts) as EffortValue | undefined) : options.effortValue
  const requestedEffort = resolveWireRequestedEffort(modelId, effortValue, effortContext)
  const effortTruth = resolveEffortTruth(modelId, effortValue, effortContext)
  let profile: GptReasoningProfile = candidate
    ? resolveGptReasoningProfile(requestedEffort, candidate.live)
    : remembered !== undefined
      ? resolveGptReasoningProfile(requestedEffort, { supportedReasoningEfforts: [...remembered.vocabulary], ...(remembered.defaultEffort !== undefined ? { defaultReasoningEffort: remembered.defaultEffort } : {}), ...(remembered.wordsFromRow === true ? { effortWordsFromRow: true as const } : {}) })
      : { source: 'model-default' }
  const accountRoad = auth.account.label
  const listedWords = candidate !== undefined ? liveGptListedEffortWords(modelId) : undefined
  const wireRefusedWord = (asked: string): boolean =>
    candidate !== undefined &&
    listedWords !== undefined &&
    listedWords.includes(asked) &&
    !candidate.live.supportedReasoningEfforts.includes(asked)
  const receiptOf = (
    profile: GptReasoningProfile,
    refusedByWire = profile.adjustedFrom !== undefined && wireRefusedWord(profile.adjustedFrom),
  ): EffortAdjustedV1 | undefined =>
    profile.source === 'unsupported-fallback' && profile.adjustedFrom !== undefined
      ? {
          model: modelId,
          name: getPublicModelDisplayName(modelId) ?? modelId,
          asked: profile.adjustedFrom,
          ...(profile.wireEffort !== undefined ? { sent: profile.wireEffort } : {}),
          ...(refusedByWire
            ? { wireRefused: { road: accountRoad, reprobeAfter: describeWireEffortProbeWindow() } }
            : {}),
        }
      : undefined
  let effortAdjusted: EffortAdjustedV1 | undefined = receiptOf(profile)
  return { remembered, requestedEffort, effortTruth, profile, receiptOf, effortAdjusted }
}

export type TurnEffort = ReturnType<typeof resolveTurnEffort>
