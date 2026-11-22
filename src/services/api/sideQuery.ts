import type { ApiMessage } from '../../types/wire.js'
import { setLastApiCompletionTimestamp } from '../../bootstrap/state.js'
import { STRUCTURED_OUTPUTS_BETA_HEADER } from '../../constants/betas.js'
import { getAttributionHeader } from '../../constants/system.js'
import type { QuerySource } from '../../constants/querySource.js'
import { getAnthropicClient } from './client.js'
import { isClientContractRefusalError } from '../../utils/api/clientContractGate.js'
import { healClientContractRefusal, noteClientContractHeal } from './clientContractLearned.js'
import { getAPIMetadata } from '../providers/anthropic/requestParams.js'
import type { AnthropicMessageParams, AnthropicOutputConfig } from '../../types/anthropicWire.js'
import type { ApiToolUnion, JsonOutputFormat, MessageParam, TextBlockParam } from '../../types/wire.js'
import { computeFingerprint } from '../../utils/fingerprint.js'
import {
  foldToolChoiceForModel,
  getMergedBetas,
  modelSupportsAdaptiveThinking,
  modelSupportsStructuredOutputs,
  modelSupportsTemperature,
  modelThinkingAlwaysOn,
} from '../../utils/model/capabilities.js'
import { normalizeModelStringForAPI } from '../model/model.js'
import { notBuilt, type Unbuilt } from '../../pi/holes.js'


type SideQueryOptions = Unbuilt

function harnessVersion(): string {
  return typeof MACRO !== 'undefined' && MACRO.VERSION ? MACRO.VERSION : '0.0.0'
}

type SideQueryThinkingParam =
  | { type: 'disabled' }
  | { type: 'adaptive' }
  | { type: 'enabled'; budget_tokens: number }
  | undefined

export function sideQueryThinkingParam(
  model: string,
  thinking: SideQueryOptions['thinking'],
  maxTokens: number,
): SideQueryThinkingParam {
  return notBuilt('src/services/api/sideQuery.ts:53')
}

export async function sideQuery(opts: SideQueryOptions): Promise<ApiMessage> {
  return notBuilt('src/services/api/sideQuery.ts:78')
}
