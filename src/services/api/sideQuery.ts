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


type SideQueryOptions = {
  model: string
  messages: MessageParam[]
  querySource: QuerySource | (string & {})
  system?: string | TextBlockParam[]
  tools?: ApiToolUnion[]
  tool_choice?: AnthropicMessageParams['tool_choice']
  output_format?: JsonOutputFormat
  max_tokens?: number
  maxRetries?: number
  signal?: AbortSignal
  temperature?: number
  thinking?: number | false
  effort?: AnthropicOutputConfig['effort'] | (string & {})
  stop_sequences?: string[]
  source?: string
}

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
  if (thinking === false) {
    return modelThinkingAlwaysOn(model) ? undefined : { type: 'disabled' }
  }
  if (typeof thinking === 'number') {
    if (modelSupportsAdaptiveThinking(model)) {
      return { type: 'adaptive' }
    }
    return { type: 'enabled', budget_tokens: Math.min(thinking, maxTokens - 1) }
  }
  return undefined
}

function firstUserMessageText(messages: MessageParam[]): string {
  const firstUser = messages.find(message => message.role === 'user')
  if (!firstUser) return ''
  if (typeof firstUser.content === 'string') return firstUser.content
  if (!Array.isArray(firstUser.content)) return ''
  for (const block of firstUser.content) {
    if (block.type === 'text') return block.text
  }
  return ''
}

export async function sideQuery(opts: SideQueryOptions): Promise<ApiMessage> {
  const maxTokens = opts.max_tokens ?? 1024
  const client = await getAnthropicClient({
    maxRetries: opts.maxRetries ?? 2,
    source: opts.source ?? 'side_query',
  })

  const betas = [...getMergedBetas(opts.model)]
  if (
    opts.output_format !== undefined &&
    modelSupportsStructuredOutputs(opts.model) &&
    !betas.includes(STRUCTURED_OUTPUTS_BETA_HEADER)
  ) {
    betas.push(STRUCTURED_OUTPUTS_BETA_HEADER)
  }

  const fingerprint = computeFingerprint(firstUserMessageText(opts.messages), harnessVersion())
  const attributionHeader = getAttributionHeader(fingerprint)

  const systemBlocks: TextBlockParam[] = []
  if (attributionHeader) {
    systemBlocks.push({ type: 'text', text: attributionHeader })
  }
  if (opts.system !== undefined) {
    if (typeof opts.system === 'string') {
      systemBlocks.push({ type: 'text', text: opts.system })
    } else {
      systemBlocks.push(...opts.system)
    }
  }

  const thinking = sideQueryThinkingParam(opts.model, opts.thinking, maxTokens)
  const toolChoice = opts.tool_choice !== undefined
    ? foldToolChoiceForModel(opts.model, opts.tool_choice)
    : undefined
  const outputConfig: AnthropicOutputConfig | undefined =
    opts.output_format !== undefined || opts.effort !== undefined
      ? {
          ...(opts.output_format !== undefined ? { format: opts.output_format } : {}),
          ...(opts.effort !== undefined
            ? { effort: opts.effort as AnthropicOutputConfig['effort'] }
            : {}),
        }
      : undefined

  const params: AnthropicMessageParams & { stream?: false } = {
    model: normalizeModelStringForAPI(opts.model),
    max_tokens: maxTokens,
    messages: opts.messages,
    system: systemBlocks,
    metadata: getAPIMetadata(),
    ...(opts.temperature !== undefined && modelSupportsTemperature(opts.model)
      ? { temperature: opts.temperature }
      : {}),
    ...(thinking !== undefined ? { thinking } : {}),
    ...(opts.tools !== undefined ? { tools: opts.tools } : {}),
    ...(toolChoice !== undefined ? { tool_choice: toolChoice } : {}),
    ...(opts.stop_sequences !== undefined ? { stop_sequences: opts.stop_sequences } : {}),
    ...(outputConfig !== undefined ? { output_config: outputConfig } : {}),
    ...(betas.length > 0 ? { betas } : {}),
  }

  const requestOptions = opts.signal !== undefined ? { signal: opts.signal } : undefined

  let response: ApiMessage
  try {
    response = await client.beta.messages.create(params, requestOptions)
  } catch (error) {
    if (!isClientContractRefusalError(error)) throw error
    const heal = await healClientContractRefusal(error, opts.signal)
    const healedHeader = getAttributionHeader(fingerprint)
    if (heal.kind !== 'retry' || !attributionHeader || healedHeader === attributionHeader) {
      noteClientContractHeal(error, heal)
      throw error
    }
    const retryParams: AnthropicMessageParams & { stream?: false } = {
      ...params,
      system: [{ type: 'text', text: healedHeader }, ...systemBlocks.slice(1)],
    }
    try {
      response = await client.beta.messages.create(retryParams, requestOptions)
    } catch (retryError) {
      if (isClientContractRefusalError(retryError)) {
        noteClientContractHeal(retryError, heal)
      }
      throw retryError
    }
  }

  setLastApiCompletionTimestamp(Date.now())
  return response
}
