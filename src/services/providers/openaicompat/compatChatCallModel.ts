import { llamacppOriginRefusal } from './compatRefusals.js'
import type {
  AssistantMessage,
  Message,
  StreamEvent,
  SystemAPIErrorMessage,
} from '../../../types/message.js'
import { API_ERROR_MESSAGE_PREFIX } from '../../api/errors.js'
import { streamReconnectSpentLine } from '../streamIdleBudget.js'
import { retrySeconds, stampProviderWait } from '../../api/recoveryBudget.js'
import { markUnknownModel } from '../../api/backupEngines.js'
import { openTurnRetries } from '../../api/withRetry.js'
import { busyRefusalFact, takesBusyLadder } from '../busyRetry.js'
import { emptyStreamSpentWords } from '../emptyStreamRetry.js'
import { replayKimiHistory } from './kimiReplay.js'
import { recordLaneBillingRefusal, recordLaneTurnSettled } from '../laneBillingState.js'
import { captureSignInRequest, observeSignInResponse } from '../signInRefusal.js'
import { classifyCredentialWall, credentialWallLine } from '../credentialWall.js'
import { logForDebugging } from '../../../utils/debug.js'
import { canonicalWireModelId } from '../routeLaw.js'
import { imageRefusalWords } from '../zai/zaiCodec.js'
import { noteImageRefusal } from '../../desktop/desktopSession.js'
import { compatImageRefusalWords, refreshCompatModelImageReading } from './compatProbe.js'
import {
  type CompatFault,
} from './compatChatClient.js'
import { localServerKind } from '../../../constants/localPromptProfile.js'
import { compatDispatchModelId, type CompatCallModelParams, type CompatLaneId, type CompatLaneProfile } from './compatChatCallModel/lane.js'
import { apiErrorMessage, compatFaultToTypedError, compatTerminalFaultText, overflowOf } from './compatChatCallModel/faults.js'
import { openCompatTurn, prepareCompatTurn } from './compatChatCallModel/prepare.js'
import { streamOneCompatAttempt } from './compatChatCallModel/attempt.js'
import { passedOver, passedOverAs } from '../../../utils/passedOver.js'
import { notBuilt } from '../../../pi/holes.js'

export { compatDispatchModelId, imagesSupportedForCompatModel, laneExtrasWithOperatorEffort, type CompatCallModelParams, type CompatLaneProfile } from './compatChatCallModel/lane.js'
export { compatFaultToTypedError, compatTerminalFaultText } from './compatChatCallModel/faults.js'
export { mapCompatUsageToAnthropic } from './compatChatCallModel/attemptSettle.js'

const COMPAT_MAX_ATTEMPTS = 2
const COMPAT_RETRY_BACKOFF_MS = 400

const liveProof = new Map<CompatLaneId, { at: number; model: string }>()
export function compatLaneLiveProofState(lane: CompatLaneId): { at: number; model: string } | null {
  return liveProof.get(lane) ?? null
}

export async function* compatChatCallModel(
  profile: CompatLaneProfile,
  params: CompatCallModelParams,
): AsyncGenerator<StreamEvent | AssistantMessage | SystemAPIErrorMessage, void> {
  return notBuilt('src/services/providers/openaicompat/compatChatCallModel.ts:46')
}
