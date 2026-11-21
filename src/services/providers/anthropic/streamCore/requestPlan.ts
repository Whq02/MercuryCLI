import type { ApiToolUnion as BetaToolUnion } from '../../../../types/wire.js'
import { getToolSearchBetaHeader } from 'src/utils/betas.js'
import { noteCacheClockPrefix } from 'src/utils/cache/cacheClock.js'
import { logForDebugging } from 'src/utils/debug.js'
import type { ThinkingConfig } from 'src/utils/thinking.js'
import { getAttributionHeader } from '../../../../constants/system.js'
import type {
  Tool,
  Tools,
} from '../../../../Tool.js'
import { ensureGatewayProbe, gatewayProbePolicyAllows, type GatewayProbeAnswer } from '../../deferralProbe.js'
import { gatewayHost } from '../../deferralWire.js'
import { deadlineBreachLine, isDeadlineBreach } from '../../fetchDeadline.js'
import { conversationRosterKey, planToolPayload, renderAdmissionRecordsAsText } from '../../toolEconomy.js'
import { declareLawfulPrefixChange } from '../../lawfulPrefixChange.js'
import { carriesThinking, deadThinkingMarks, droppedThinkingMarks, stripDeadThinking, thinkingCarryRides, thinkingPrefixDigest } from '../thinkingBinding.js'
import type {
  AssistantMessage,
  Message,
  UserMessage,
} from '../../../../types/message.js'
import { toolToAPISchema } from '../../../messages/api.js'
import { isToolSearchEnabledOptimistic, isToolSearchToolAvailable, modelSupportsToolReference } from '../../../messages/toolSearch.js'
import { getMergedBetas } from '../../../../utils/betas.js'
import { isTurnOwningQuerySource } from '../../../../utils/effort.js'
import { computeFingerprintFromMessages } from '../../../../utils/fingerprint.js'
import {
  normalizeMessagesForAPI,
  stripCallerFieldFromAssistantMessage,
  stripToolReferenceBlocksFromUserMessage,
  stripUnsignedThinkingBlocks,
} from '../../../messages.js'
import { stripThinkingFromIndex, stripThinkingFromOtherModels } from '../../../messages/apiFilters.js'
import { pairConversationMessages } from '../../../messages/pairing.js'
import type { SystemPrompt } from '../../../../utils/systemPromptType.js'
import { getAnthropicClient } from '../../../api/client.js'
import {
  assembleTurnSystemPrompt,
  buildSystemPromptBlocks,
} from '../cacheAndUsage.js'
import { retireOlderScreenshots } from '../../../desktop/screenshotRetention.js'
import { getPromptCachingEnabled } from '../requestParams.js'
import type { RequestImageFit } from '../../../../utils/imageResizer.js'
import type { Options } from '../streamCore.js'
import type { AnthropicMessageParams } from '../../../../types/anthropicWire.js'

const GATEWAY_PROBE_TIMEOUT_MS = 8_000
async function sendGatewayProbe(
  body: AnthropicMessageParams,
  betaHeader: string,
  options: Options,
): Promise<GatewayProbeAnswer> {
  try {
    const client = await getAnthropicClient({
      maxRetries: 0,
      fetchOverride: options.fetchOverride,
      source: options.querySource,
    })
    await client.beta.messages.create(
      { ...body, betas: [betaHeader] },
      { timeout: GATEWAY_PROBE_TIMEOUT_MS, maxRetries: 0 },
    )
    return { status: 200, bodyText: '' }
  } catch (error) {
    if (isDeadlineBreach(error)) {
      return { status: null, bodyText: deadlineBreachLine('the gateway', GATEWAY_PROBE_TIMEOUT_MS) }
    }
    const status = (error as { status?: unknown }).status
    return {
      status: typeof status === 'number' ? status : null,
      bodyText: error instanceof Error ? error.message : String(error),
    }
  }
}

function withoutToolSearchFields(message: UserMessage | AssistantMessage): UserMessage | AssistantMessage {
  return message.type === 'user'
    ? stripToolReferenceBlocksFromUserMessage(message)
    : stripCallerFieldFromAssistantMessage(message)
}

export function requestBetas(options: Options) {
  const isAgenticQuery =
    options.querySource.startsWith('main_thread') ||
    options.querySource.startsWith('agent:') ||
    options.querySource === 'sdk' ||
    options.querySource === 'hook_agent' ||
    options.querySource === 'verification_agent'
  const betas = getMergedBetas(options.model, { isAgenticQuery })
  return betas
}

export function toolRosterOf(
  plan: Awaited<ReturnType<typeof planToolPayload>>,
  betas: string[],
  tools: Tools,
  options: Options,
  rosterOwnerKey: string,
) {
  const useToolSearch = plan.enabled
  const deferredToolNames = plan.deferredNames
  const blockForm = plan.wireForm === 'block'
  const filteredTools: Tools = plan.roster
  if (!useToolSearch) {
    logForDebugging('Tool search disabled for this request (the payload plan)')
  }
  if (plan.restoredMissingTools.length > 0) {
    declareLawfulPrefixChange(
      rosterOwnerKey,
      `a tool the earlier session offered is no longer available (${plan.restoredMissingTools.join(', ')})`,
    )
  }

  if (plan.wireWhy === 'gateway-unprobed' && gatewayProbePolicyAllows() && modelSupportsToolReference(options.model) && isToolSearchToolAvailable(tools) && isToolSearchEnabledOptimistic()) {
    const host = gatewayHost()
    if (host !== null) {
      void ensureGatewayProbe(
        host,
        (body, betaHeader) => sendGatewayProbe(body, betaHeader, options),
        options.model,
      )
    }
  }

  const toolSearchHeader = useToolSearch && blockForm ? getToolSearchBetaHeader() : null
  if (toolSearchHeader && !betas.includes(toolSearchHeader)) {
    betas.push(toolSearchHeader)
  }

  const willDefer = (t: Tool) => useToolSearch && blockForm && deferredToolNames.has(t.name)
  return { useToolSearch, blockForm, filteredTools, willDefer }
}

export function messagesBeforeImages(
  messages: Message[],
  filteredTools: Tools,
  useToolSearch: boolean,
  blockForm: boolean,
  rosterOwnerKey: string,
) {
  let messagesForAPI = normalizeMessagesForAPI(messages, filteredTools)

  if (!useToolSearch) {
    messagesForAPI = messagesForAPI.map(withoutToolSearchFields)
  } else if (!blockForm) {
    messagesForAPI = renderAdmissionRecordsAsText(messagesForAPI).map(msg =>
      msg.type === 'assistant' ? stripCallerFieldFromAssistantMessage(msg) : msg,
    )
  }

  messagesForAPI = pairConversationMessages(messagesForAPI, 'canonical')

  messagesForAPI = stripUnsignedThinkingBlocks(messagesForAPI)

  const retiredScreenshots = retireOlderScreenshots(messagesForAPI, undefined, undefined, rosterOwnerKey)
  messagesForAPI =
    retiredScreenshots.firstEdited === -1
      ? retiredScreenshots.messages
      : stripThinkingFromIndex(retiredScreenshots.messages, retiredScreenshots.firstEdited)
  return messagesForAPI
}

export function wireRequestOf(
  fittedImages: RequestImageFit<ReturnType<typeof messagesBeforeImages>[number]>,
  messages: Message[],
  systemPrompt: SystemPrompt,
  thinkingConfig: ThinkingConfig,
  options: Options,
  rosterOwnerKey: string,
  toolSchemas: Awaited<ReturnType<typeof toolToAPISchema>>[],
) {
  let messagesForAPI =
    fittedImages.firstEdited === -1
      ? fittedImages.messages
      : stripThinkingFromIndex(fittedImages.messages, fittedImages.firstEdited)

  messagesForAPI = stripDeadThinking(messagesForAPI, deadThinkingMarks(messages))
  if (thinkingConfig.type === 'disabled') messagesForAPI = stripThinkingFromIndex(messagesForAPI, 0)

  const fingerprint = computeFingerprintFromMessages(messages)
  const prefixKey = conversationRosterKey(rosterOwnerKey, messages, options.model)
  const turnOwning = isTurnOwningQuerySource(options.querySource)
  if (turnOwning) noteCacheClockPrefix(prefixKey)

  const sessionSystemPrompt = systemPrompt
  const assembleSystemPrompt = (attribution: string): SystemPrompt =>
    assembleTurnSystemPrompt(attribution, sessionSystemPrompt)
  let attributionLine = getAttributionHeader(fingerprint)
  systemPrompt = assembleSystemPrompt(attributionLine)

  const enablePromptCaching =
    options.enablePromptCaching ?? getPromptCachingEnabled(options.model)
  let system = buildSystemPromptBlocks(systemPrompt, enablePromptCaching)
  const systemForAttribution = (attribution: string): typeof system =>
    buildSystemPromptBlocks(assembleSystemPrompt(attribution), enablePromptCaching)

  const extraToolSchemas = [...(options.extraToolSchemas ?? [])]
  if (options.nativeWebSearch) {
    const { allowedDomains, blockedDomains, maxUses } = options.nativeWebSearch
    extraToolSchemas.push({
      type: 'web_search_20250305',
      name: 'web_search',
      ...(allowedDomains && allowedDomains.length > 0 ? { allowed_domains: allowedDomains } : {}),
      ...(blockedDomains && blockedDomains.length > 0 ? { blocked_domains: blockedDomains } : {}),
      max_uses: maxUses,
    })
  }
  const allTools: BetaToolUnion[] = [...toolSchemas, ...extraToolSchemas]

  const carryPrefix = thinkingCarryRides() ? thinkingPrefixDigest(system, allTools) : undefined
  const droppedThinking = droppedThinkingMarks(messages)
  messagesForAPI = stripThinkingFromOtherModels(
    messagesForAPI,
    options.model,
    (_writer, target, row) => carriesThinking(row, target, carryPrefix, droppedThinking),
  )

  return { messagesForAPI, fingerprint, prefixKey, turnOwning, attributionLine, system, systemForAttribution, allTools }
}
