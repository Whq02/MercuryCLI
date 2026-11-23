import type { Options } from '../../anthropic/streamCore.js'
import {
  type ApexGptRole,
} from '../openaiCatalogue.js'
import { noteWireEffortAccepted, recordLiveQualification } from '../qualificationStore.js'
import { clearOpenaiUsageLimit } from '../openaiLimitState.js'
import { recordLaneTurnSettled } from '../../laneBillingState.js'
import { captureSignInRequest, observeSignInResponse } from '../../signInRefusal.js'
import { priorConversation4xx } from './resumeTrim.js'
import type { OpenaiTurn } from './turnState.js'
import { passedOver } from '../../../../platform/errors/passedOver.js'

let openaiLiveProof: { at: number; model: string } | null = null
export function openaiLiveProofState(): { at: number; model: string } | null {
  return openaiLiveProof
}

function activeApexRole(options: Options): ApexGptRole {
  if (options.agentId || String(options.querySource ?? '').startsWith('agent')) {
    return 'specialist'
  }
  return 'primary'
}

export async function settleOpenaiTurn(
  turn: OpenaiTurn,
  signInRequest: ReturnType<typeof captureSignInRequest>,
  attemptStartedAtMs: number,
): Promise<void> {
  const { conversation4xxKey, auth, turnStartedAtMs, modelId, options, contract, profile } = turn
  priorConversation4xx.delete(conversation4xxKey)
  observeSignInResponse(signInRequest, 200)
  clearOpenaiUsageLimit(auth.account.kind)
  try {
    const { logAPISuccessAndDuration } = await import('../../../../engine/requests/apiCallLogging.js')
    logAPISuccessAndDuration({ start: attemptStartedAtMs, startIncludingRetries: turnStartedAtMs })
  } catch (error) {
    passedOver(error)
  }
  openaiLiveProof = { at: Date.now(), model: modelId }
  recordLaneTurnSettled('openai')
  recordLiveQualification({
    modelId,
    role: activeApexRole(options),
    sourceKind: auth.account.kind,
    behaviourContractDigest: contract.digest,
    ...(profile.wireEffort ? { liveEffort: profile.wireEffort } : {}),
  })
  if (profile.wireEffort !== undefined) {
    noteWireEffortAccepted({ modelId, sourceKind: auth.account.kind, word: profile.wireEffort })
  }
}
