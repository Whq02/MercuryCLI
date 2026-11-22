import { flagEnv } from '../../../../substrate/flagRegistry.js'
import type { JsonOutputFormat as BetaJSONOutputFormat } from '../../../../types/wire.js'
import type { AnthropicMessageParams as BetaMessageStreamParams, AnthropicOutputConfig as BetaOutputConfig } from '../../../../types/anthropicWire.js'
import { MESSAGE_EFFORT_BETA_HEADER, STRUCTURED_OUTPUTS_BETA_HEADER } from 'src/constants/betas.js'
import { applyThinkingBinding } from '../thinkingBinding.js'
import { applyThinkingDisplay } from '../thinkingDisplay.js'
import { modelSupportsStructuredOutputs } from 'src/utils/betas.js'
import { getMaxThinkingTokensForModel } from 'src/utils/context.js'
import { logForDebugging } from 'src/utils/debug.js'
import {
  modelSupportsAdaptiveThinking,
  modelSupportsThinking,
  type ThinkingConfig,
} from 'src/utils/thinking.js'
import { foldToolChoiceForModel, getContextWindowForModel, modelSupportsMessageEffort, modelThinkingOffIsBetweenTools } from 'src/utils/model/capabilities.js'
import { ANTHROPIC_IMAGE_LIMITS } from '../../../../constants/apiLimits.js'
import { getAttributionHeader } from '../../../../constants/system.js'
import { declareLawfulPrefixChange } from '../../lawfulPrefixChange.js'
import { applyInducedPrefixEdit, inducedEditApplies, judgeAndRecordPrefix, resolveInducedPrefixEdit, type WirePrefixParts } from '../prefixLedger.js'
import { cacheDiagnosticsParam } from '../cacheDiagnostics.js'
import { thinkingPrefixDigest } from '../thinkingBinding.js'
import type { Message } from '../../../../types/message.js'
import { modelSupportsTemperature } from '../../../../utils/betas.js'
import { getModelMaxOutputTokens } from '../../../../utils/context.js'
import { isTurnOwningQuerySource, resolveAppliedEffort } from '../../../../utils/effort.js'
import { validateBoundedIntEnvVar } from '../../../../utils/envValidation.js'
import { normalizeModelStringForAPI } from '../../../model/model.js'
import {
  consumePendingCacheEdits,
  getPinnedCacheEdits,
} from '../../../compact/microCompact.js'
import { clientContractMoveOf } from '../../../api/clientContractLearned.js'
import type { RetryContext } from '../../../api/withRetry.js'
import { fitOutputTokensForRequest, outputFitWords } from '../../../api/outputFit.js'
import {
  addCacheBreakpoints,
  type CachedMCEditsBlock,
  type CachedMCPinnedEdits,
} from '../cacheAndUsage.js'
import { fitWireImages } from '../../../../utils/messages/imageRequestFit.js'
import {
  configureEffortParams,
  getAPIMetadata,
  getExtraBodyParams,
  getPromptCachingEnabled,
} from '../requestParams.js'
import type { Options } from '../streamCore.js'
import type { CallState, PlannedRequest } from './state.js'
import { messageEffortRow, messageEffortSteps, withMessageEffort } from '../messageEffort.js'
import { notBuilt, type Unbuilt } from '../../../../pi/holes.js'

type WireInputs = Unbuilt

export function wireParamsFor(call: CallState, wire: WireInputs): Unbuilt {
  return notBuilt('src/services/providers/anthropic/streamCore/wireParams.ts:65')
}

export function getMaxOutputTokensForModel(model: string): number {
  return notBuilt('src/services/providers/anthropic/streamCore/wireParams.ts:229')
}
