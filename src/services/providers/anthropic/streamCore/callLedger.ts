import { APIError } from '../../../../utils/api/sdkErrors.js'
import type {
  ContentBlock as BetaContentBlock,
  ApiMessage as BetaMessage,
} from '../../../../types/wire.js'
import { randomUUID } from 'crypto'
import { addToTotalSessionCost } from 'src/cost-tracker.js'
import { logForDebugging } from 'src/utils/debug.js'
import { calculateUSDCost } from 'src/services/usage/modelCost.js'
import { roughTokenCountEstimation } from 'src/services/tokenEstimation.js'
import type { Tools } from '../../../../Tool.js'
import type { ConnectorTextBlock } from '../../../../types/connectorText.js'
import type { AssistantMessage } from '../../../../types/message.js'
import { normalizeContentFromAPI } from '../../../messages.js'
import {
  getCanonicalName,
  normalizeModelStringForAPI,
} from '../../../model/model.js'
import { extractQuotaStatusFromError } from '../../../anthropicLimits.js'
import {
  logAPIError,
  type NonNullableUsage,
} from '../../../api/logging.js'
import { CannotRetryError } from '../../../api/withRetry.js'
import { cleanupStream } from '../cacheAndUsage.js'
import type { Options } from '../streamCore.js'
import type { CallState, SignInRefusal } from './state.js'
import { passedOver } from '../../../../utils/passedOver.js'
import { notBuilt, type Unbuilt } from '../../../../pi/holes.js'

export function createCallLedger(
  call: CallState,
  tools: Tools,
  options: Options,
  resolvedModel: string,
  newMessages: AssistantMessage[],
  contentBlocks: (BetaContentBlock | ConnectorTextBlock)[],
  stoppedBlockIndices: Set<number>,
  observeSignInResponse: SignInRefusal['observeSignInResponse'],
): Unbuilt {
  return notBuilt('src/services/providers/anthropic/streamCore/callLedger.ts:30')
}
