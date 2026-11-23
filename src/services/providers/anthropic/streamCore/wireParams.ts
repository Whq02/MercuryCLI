import { flagEnv } from '../../../../substrate/flagRegistry.js'
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
function isCachedMCEditsBlock(value: unknown): value is CachedMCEditsBlock {
  return (
    typeof value === 'object' &&
    value !== null &&
    'type' in value &&
    value.type === 'cache_edits' &&
    'edits' in value &&
    Array.isArray(value.edits)
  )
}

type WireInputs = {
  messages: Message[]
  thinkingConfig: ThinkingConfig
  options: Options
  betas: string[]
  rosterOwnerKey: string
  planned: PlannedRequest
  cachedMCEnabled: boolean
  cacheEditingHeaderLatched: boolean
  effort: ReturnType<typeof resolveAppliedEffort>
  consumedCacheEdits: ReturnType<typeof consumePendingCacheEdits>
  consumedPinnedEdits: ReturnType<typeof getPinnedCacheEdits>
}

export function wireParamsFor(call: CallState, wire: WireInputs): (context: RetryContext) => BetaMessageStreamParams {
  let attributionLine = wire.planned.attributionLine
  let system = wire.planned.system

  return (context: RetryContext): BetaMessageStreamParams => {
    const nextAttribution = getAttributionHeader(wire.planned.fingerprint)
    if (nextAttribution !== attributionLine) {
      attributionLine = nextAttribution
      system = wire.planned.systemForAttribution(nextAttribution)
    }

    const requestBetas = [...wire.betas]
    const extraBodyParams = getExtraBodyParams()
    const rawExtraOutputConfig = extraBodyParams.output_config
    const outputConfig: BetaOutputConfig =
      rawExtraOutputConfig && typeof rawExtraOutputConfig === 'object' && !Array.isArray(rawExtraOutputConfig)
        ? { ...(rawExtraOutputConfig as BetaOutputConfig) }
        : {}

    configureEffortParams(wire.effort, outputConfig, extraBodyParams, wire.options.model)

    if (wire.options.outputFormat && !Object.hasOwn(outputConfig, 'format')) {
      outputConfig.format = wire.options.outputFormat
      if (modelSupportsStructuredOutputs(wire.options.model) && !requestBetas.includes(STRUCTURED_OUTPUTS_BETA_HEADER)) {
        requestBetas.push(STRUCTURED_OUTPUTS_BETA_HEADER)
      }
    }

    const thinkingEnabled = wire.thinkingConfig.type !== 'disabled' && modelSupportsThinking(wire.options.model)
    const isAdaptiveThinking = wire.thinkingConfig.type === 'adaptive' && modelSupportsAdaptiveThinking(wire.options.model)
    const plannedThinkingBudget =
      thinkingEnabled && !isAdaptiveThinking
        ? wire.thinkingConfig.type === 'enabled'
          ? wire.thinkingConfig.budgetTokens
          : getMaxThinkingTokensForModel(wire.options.model)
        : 0

    const askedMaxTokens =
      context.maxTokensOverride ||
      wire.options.maxOutputTokensOverride ||
      getMaxOutputTokensForModel(wire.options.model)
    const outputFit = fitOutputTokensForRequest({
      asked: askedMaxTokens,
      messages: wire.messages,
      model: wire.options.model,
      fixed: { system, tools: wire.planned.allTools },
      betas: wire.betas,
      least: plannedThinkingBudget + 1,
    })
    if (outputFit.clamped) {
      logForDebugging(outputFitWords(outputFit, wire.options.model))
    }
    const maxTokens = outputFit.tokens

    const rawThinking: BetaMessageStreamParams['thinking'] = thinkingEnabled
      ? isAdaptiveThinking
        ? { type: 'adaptive' }
        : { budget_tokens: Math.min(plannedThinkingBudget, maxTokens - 1), type: 'enabled' }
      : undefined
    const boundThinking = applyThinkingBinding(
      applyThinkingDisplay(wire.options.model, rawThinking, requestBetas),
      requestBetas,
    ) as BetaMessageStreamParams['thinking']
    const betweenTools =
      wire.thinkingConfig.type === 'disabled' &&
      modelThinkingOffIsBetweenTools(wire.options.model, outputConfig)
    const thinking: BetaMessageStreamParams['thinking'] = betweenTools
      ? { type: 'between_tools' }
      : boundThinking

    const effortSteps =
      !betweenTools && modelSupportsMessageEffort(wire.options.model)
        ? messageEffortSteps(wire.planned.messagesForAPI, outputConfig.effort)
        : []
    if (effortSteps.length > 0 && !requestBetas.includes(MESSAGE_EFFORT_BETA_HEADER)) {
      requestBetas.push(MESSAGE_EFFORT_BETA_HEADER)
    }

    const temperature = thinkingEnabled
      ? undefined
      : modelSupportsTemperature(wire.options.model)
        ? (wire.options.temperatureOverride ?? 1)
        : undefined

    const enablePromptCaching = wire.options.enablePromptCaching ?? getPromptCachingEnabled(context.model)
    const useCachedMC = wire.options.querySource === 'main_thread' && wire.cachedMCEnabled

    const emitBetas = requestBetas.length > 0
    if (wire.options.querySource === 'main_thread' && wire.cacheEditingHeaderLatched) {
      const cacheEditingBeta = ''
      if (!requestBetas.includes(cacheEditingBeta)) {
        requestBetas.push(cacheEditingBeta)
        logForDebugging('Cache editing beta header enabled for cached microcompact')
      }
    }

    const foldedToolChoice = foldToolChoiceForModel(wire.options.model, wire.options.toolChoice)
    if (foldedToolChoice !== wire.options.toolChoice) {
      logForDebugging(`forced tool_choice folded to auto for ${wire.options.model} (the model rejects forced tool choice)`)
    }

    const freshEdits: CachedMCEditsBlock | null =
      wire.consumedCacheEdits !== null && isCachedMCEditsBlock(wire.consumedCacheEdits.block)
        ? wire.consumedCacheEdits.block
        : null
    const pinnedEdits: CachedMCPinnedEdits[] = wire.consumedPinnedEdits.flatMap(entry =>
      isCachedMCEditsBlock(entry.block) ? [{ userMessageIndex: entry.userMessageIndex, block: entry.block }] : [],
    )
    let wirePrefix: WirePrefixParts = {
      system,
      tools: wire.planned.allTools,
      messages: addCacheBreakpoints(
        wire.planned.messagesForAPI,
        enablePromptCaching,
        useCachedMC,
        freshEdits,
        pinnedEdits,
        wire.options.skipCacheWrite,
      ),
    }
    const inducedEdit = resolveInducedPrefixEdit()
    if (inducedEdit !== null && inducedEditApplies(wire.messages)) {
      wirePrefix = applyInducedPrefixEdit(wirePrefix, inducedEdit)
    }

    const wireMessages = withMessageEffort<unknown>(
      wirePrefix.messages,
      effortSteps,
      messageEffortRow,
    ) as BetaMessageStreamParams['messages']
    const baseWireMessageIds: Array<string | null> = wire.planned.messagesForAPI.map(msg =>
      msg.type === 'assistant' ? msg.message.id : null,
    )
    const wireMessageIds = withMessageEffort<string | null>(baseWireMessageIds, effortSteps, () => null)
    const diagnostics = cacheDiagnosticsParam(wireMessageIds, wire.options.querySource)

    const params: BetaMessageStreamParams = {
      model: normalizeModelStringForAPI(wire.options.model),
      messages: wireMessages,
      system: wirePrefix.system as BetaMessageStreamParams['system'],
      tools: wirePrefix.tools as BetaMessageStreamParams['tools'],
      tool_choice: foldedToolChoice,
      ...(emitBetas ? { betas: requestBetas } : {}),
      metadata: getAPIMetadata(),
      max_tokens: maxTokens,
      thinking,
      ...(temperature !== undefined ? { temperature } : {}),
      ...(diagnostics !== null ? { diagnostics } : {}),
      ...extraBodyParams,
      ...(Object.keys(outputConfig).length > 0 ? { output_config: outputConfig } : {}),
    }

    const contextWindow = getContextWindowForModel(wire.options.model, requestBetas)
    const imageLimits =
      contextWindow <= 200_000
        ? { ...ANTHROPIC_IMAGE_LIMITS, maxImagesPerRequest: 100 }
        : ANTHROPIC_IMAGE_LIMITS
    const fitted = fitWireImages(params, imageLimits).request

    call.sentThinkingPrefix = thinkingPrefixDigest(fitted.system, fitted.tools)
    const verdictIds = fitted.messages === wireMessages ? wireMessageIds : fitted.messages.map(() => null)
    const verdict = judgeAndRecordPrefix(
      wire.rosterOwnerKey,
      wire.planned.prefixKey,
      { system: fitted.system, tools: fitted.tools ?? [], messages: fitted.messages },
      verdictIds,
      { replaceRecord: isTurnOwningQuerySource(wire.options.querySource) },
    )
    call.ledgerFirstDifference = verdict.mismatch
    const contractMove = clientContractMoveOf(verdict.mismatch)
    if (contractMove !== null) {
      declareLawfulPrefixChange(wire.rosterOwnerKey, contractMove)
    }

    return fitted
  }
}

export function getMaxOutputTokensForModel(model: string): number {
  const { default: defaultValue, upperLimit } = getModelMaxOutputTokens(model)
  const { effective } = validateBoundedIntEnvVar(
    'MERCURY_MAX_OUTPUT_TOKENS',
    flagEnv('MERCURY_MAX_OUTPUT_TOKENS'),
    defaultValue,
    upperLimit,
  )
  return effective
}
