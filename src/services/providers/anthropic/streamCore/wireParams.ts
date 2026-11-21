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
import { foldToolChoiceForModel, getContextWindowForModel, modelSupportsMessageEffort } from 'src/utils/model/capabilities.js'
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

type WireInputs = {
  messages: Message[]
  thinkingConfig: ThinkingConfig
  options: Options
  betas: string[]
  rosterOwnerKey: string
  planned: PlannedRequest
  cachedMCEnabled: boolean
  cacheEditingHeaderLatched: boolean
  effort: ReturnType<typeof resolveAppliedEffort> | undefined
  consumedCacheEdits: ReturnType<typeof consumePendingCacheEdits> | null
  consumedPinnedEdits: ReturnType<typeof getPinnedCacheEdits>
}

export function wireParamsFor(call: CallState, wire: WireInputs) {
  const { messages, thinkingConfig, options, betas, rosterOwnerKey, planned, cachedMCEnabled, cacheEditingHeaderLatched, effort, consumedCacheEdits, consumedPinnedEdits } = wire
  const { messagesForAPI, fingerprint, prefixKey, systemForAttribution, allTools } = planned
  let { attributionLine, system } = planned
  const cacheEditingBetaHeader = ''

  const paramsFromContext = (retryContext: RetryContext) => {
    const attribution = getAttributionHeader(fingerprint)
    if (attribution !== attributionLine) {
      attributionLine = attribution
      system = systemForAttribution(attribution)
    }
    const betasParams = [...betas]

    const extraBodyParams = getExtraBodyParams([])

    const outputConfig: BetaOutputConfig = {
      ...((extraBodyParams.output_config as BetaOutputConfig) ?? {}),
    }

    configureEffortParams(
      effort,
      outputConfig,
      extraBodyParams,
      options.model,
    )

    if (options.outputFormat && !('format' in outputConfig)) {
      outputConfig.format = options.outputFormat as BetaJSONOutputFormat
      if (
        modelSupportsStructuredOutputs(options.model) &&
        !betasParams.includes(STRUCTURED_OUTPUTS_BETA_HEADER)
      ) {
        betasParams.push(STRUCTURED_OUTPUTS_BETA_HEADER)
      }
    }

    const hasThinking = thinkingConfig.type !== 'disabled'
    const budgetThinking = hasThinking && modelSupportsThinking(options.model) && !modelSupportsAdaptiveThinking(options.model)
    const plannedThinkingBudget = !budgetThinking
      ? 0
      : thinkingConfig.type === 'enabled' && thinkingConfig.budgetTokens !== undefined
        ? thinkingConfig.budgetTokens
        : getMaxThinkingTokensForModel(options.model)

    const outputFit = fitOutputTokensForRequest({
      asked:
        retryContext?.maxTokensOverride ||
        options.maxOutputTokensOverride ||
        getMaxOutputTokensForModel(options.model),
      messages,
      model: options.model,
      fixed: [system, allTools],
      betas,
      least: plannedThinkingBudget + 1,
    })
    if (outputFit.clamped) logForDebugging(outputFitWords(outputFit, options.model))
    const maxOutputTokens = outputFit.tokens

    let thinking: BetaMessageStreamParams['thinking'] | undefined = undefined

    if (hasThinking && modelSupportsThinking(options.model)) {
      if (modelSupportsAdaptiveThinking(options.model)) {
        thinking = {
          type: 'adaptive',
        } satisfies BetaMessageStreamParams['thinking']
      } else {
        const thinkingBudget = Math.min(maxOutputTokens - 1, plannedThinkingBudget)
        thinking = {
          budget_tokens: thinkingBudget,
          type: 'enabled',
        } satisfies BetaMessageStreamParams['thinking']
      }
    }

    thinking = applyThinkingDisplay(options.model, thinking, betasParams) as typeof thinking
    thinking = applyThinkingBinding(thinking, betasParams) as typeof thinking
    const effortSteps = modelSupportsMessageEffort(options.model) ? messageEffortSteps(messagesForAPI, outputConfig.effort) : []
    if (effortSteps.length > 0 && !betasParams.includes(MESSAGE_EFFORT_BETA_HEADER)) betasParams.push(MESSAGE_EFFORT_BETA_HEADER)
    const sendBetas = betasParams.length > 0

    const enablePromptCaching =
      options.enablePromptCaching ?? getPromptCachingEnabled(retryContext.model)

    const useCachedMC =
      cachedMCEnabled &&
      options.querySource === 'main_thread'
    if (
      cacheEditingHeaderLatched &&
      options.querySource === 'main_thread' &&
      !betasParams.includes(cacheEditingBetaHeader)
    ) {
      betasParams.push(cacheEditingBetaHeader)
      logForDebugging(
        'Cache editing beta header enabled for cached microcompact',
      )
    }

    const temperature =
      !hasThinking && modelSupportsTemperature(options.model)
        ? (options.temperatureOverride ?? 1)
        : undefined

    const toolChoice = foldToolChoiceForModel(options.model, options.toolChoice)
    if (toolChoice !== options.toolChoice) {
      logForDebugging(
        `forced tool_choice folded to auto for ${options.model} (the model rejects forced tool choice)`,
      )
    }

    let wireParts: WirePrefixParts = {
      system,
      tools: allTools,
      messages: addCacheBreakpoints(
        messagesForAPI,
        enablePromptCaching,
        useCachedMC,
        consumedCacheEdits as CachedMCEditsBlock | null,
        consumedPinnedEdits as CachedMCPinnedEdits[],
        options.skipCacheWrite,
      ),
    }
    const inducedEdit = resolveInducedPrefixEdit()
    if (inducedEdit !== null && inducedEditApplies(messages)) wireParts = applyInducedPrefixEdit(wireParts, inducedEdit)
    const wireMessages = withMessageEffort<unknown>(wireParts.messages, effortSteps, messageEffortRow)
    const wireMessageIds = withMessageEffort<string | null>(messagesForAPI.map(m => (m.type === 'assistant' ? m.message.id : null)), effortSteps, () => null)
    const diagnostics = cacheDiagnosticsParam(wireMessageIds, options.querySource)

    const params = fitWireImages({
      model: normalizeModelStringForAPI(options.model),
      messages: wireMessages as ReturnType<typeof addCacheBreakpoints>,
      system: wireParts.system as typeof system,
      tools: wireParts.tools as typeof allTools,
      tool_choice: toolChoice,
      ...(sendBetas && { betas: betasParams }),
      metadata: getAPIMetadata(),
      max_tokens: maxOutputTokens,
      thinking,
      ...(temperature !== undefined && { temperature }),
      ...(diagnostics !== null && { diagnostics }),
      ...extraBodyParams,
      ...(Object.keys(outputConfig).length > 0 && {
        output_config: outputConfig,
      }),
    }, { ...ANTHROPIC_IMAGE_LIMITS, maxImagesPerRequest: getContextWindowForModel(options.model) <= 200_000 ? 100 : ANTHROPIC_IMAGE_LIMITS.maxImagesPerRequest }).request
    call.sentThinkingPrefix = thinkingPrefixDigest(params.system, params.tools)
    const verdict = judgeAndRecordPrefix(rosterOwnerKey, prefixKey, {
      system: params.system,
      tools: params.tools,
      messages: params.messages,
    }, params.messages === wireMessages ? wireMessageIds : params.messages.map(() => null), {
      replaceRecord: isTurnOwningQuerySource(options.querySource),
    })
    call.ledgerFirstDifference = verdict.mismatch
    const contractMove = clientContractMoveOf(verdict.mismatch)
    if (contractMove !== null) declareLawfulPrefixChange(rosterOwnerKey, contractMove)
    return params
  }

  return paramsFromContext
}

export function getMaxOutputTokensForModel(model: string): number {
  const maxOutputTokens = getModelMaxOutputTokens(model)

  const result = validateBoundedIntEnvVar(
    'MERCURY_MAX_OUTPUT_TOKENS',
    flagEnv('MERCURY_MAX_OUTPUT_TOKENS'),
    maxOutputTokens.default,
    maxOutputTokens.upperLimit,
  )
  return result.effective
}
