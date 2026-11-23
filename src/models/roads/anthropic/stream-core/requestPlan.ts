import type { ApiToolUnion as BetaToolUnion, TextBlockParam } from '../../../../engine/message-shapes/wire.js'
import { getMergedBetas, getToolSearchBetaHeader } from 'src/models/roads/betas.js'
import { noteCacheClockPrefix } from 'src/platform/cache-clock/cacheClock.js'
import { logForDebugging } from 'src/platform/logs/debugLog.js'
import type { ThinkingConfig } from 'src/models/effort/thinking.js'
import { getAttributionHeader } from '../../attributionHeader.js'
import type { Tool, Tools } from '../../../../tools/kit/tool.js'
import {
  ensureGatewayProbe,
  gatewayProbePolicyAllows,
  type GatewayProbeAnswer,
} from '../../deferralProbe.js'
import { gatewayHost } from '../../deferralWire.js'
import { deadlineBreachLine, isDeadlineBreach } from '../../fetchDeadline.js'
import { conversationRosterKey, planToolPayload, renderAdmissionRecordsAsText } from '../../toolEconomy.js'
import { declareLawfulPrefixChange } from '../../lawfulPrefixChange.js'
import type { AssistantMessage, Message, UserMessage } from '../../../../engine/message-shapes/message.js'
import { toolToAPISchema } from '../../../../engine/messages/apiSystemAndToolSchema.js'
import {
  isToolSearchEnabledOptimistic,
  isToolSearchToolAvailable,
  modelSupportsToolReference,
} from '../../../../engine/messages/toolSearch.js'
import {
  normalizeMessagesForAPI,
  stripCallerFieldFromAssistantMessage,
  stripToolReferenceBlocksFromUserMessage,
  stripUnsignedThinkingBlocks,
} from '../../../../engine/messages/messages.js'
import { stripThinkingFromIndex, stripThinkingFromOtherModels } from '../../../../engine/messages/apiFilters.js'
import { pairConversationMessages } from '../../../../engine/messages/wirePairing.js'
import type { SystemPrompt } from '../../../../engine/system-prompt/systemPromptType.js'
import { retireOlderScreenshots } from '../../../../integrations/desktop/screenshotRetention.js'
import { APIConnectionTimeoutError, APIError } from '../../../../engine/request-parts/sdkErrors.js'
import { isTurnOwningQuerySource } from '../../../effort/effort.js'
import { computeFingerprintFromMessages } from '../../../../engine/context-window/fingerprint.js'
import { isRecord } from '../../../../platform/primitives/isRecord.js'
import { getAnthropicClient } from '../anthropicClientFactory.js'
import { buildTurnSystemBlocks } from '../cacheAndUsage.js'
import { getPromptCachingEnabled } from '../requestParams.js'
import {
  carriesThinking,
  deadThinkingMarks,
  droppedThinkingMarks,
  stripDeadThinking,
  thinkingCarryRides,
  thinkingPrefixDigest,
} from '../thinkingBinding.js'
import type { RequestImageFit } from '../../../../platform/images/imageResizer.js'
import type { Options } from '../streamCore.js'
import type { AnthropicMessageParams } from '../anthropicWire.js'

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
    if (error instanceof APIConnectionTimeoutError || isDeadlineBreach(error)) {
      return {
        status: null,
        bodyText: deadlineBreachLine('the gateway', GATEWAY_PROBE_TIMEOUT_MS),
      }
    }
    const status =
      error instanceof APIError && typeof error.status === 'number'
        ? error.status
        : isRecord(error) && typeof error.status === 'number'
          ? error.status
          : null
    const bodyText = error instanceof Error ? error.message : String(error)
    return { status, bodyText }
  }
}

function withoutToolSearchFields(message: UserMessage | AssistantMessage): UserMessage | AssistantMessage {
  return message.type === 'user'
    ? stripToolReferenceBlocksFromUserMessage(message)
    : stripCallerFieldFromAssistantMessage(message)
}

export function requestBetas(options: Options): string[] {
  const source = options.querySource
  const isAgenticQuery =
    source.startsWith('main_thread') ||
    source.startsWith('agent:') ||
    source === 'sdk' ||
    source === 'hook_agent' ||
    source === 'verification_agent'
  return getMergedBetas(options.model, { isAgenticQuery })
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
): {
  messagesForAPI: (UserMessage | AssistantMessage)[]
  fingerprint: string
  prefixKey: string
  turnOwning: boolean
  attributionLine: string
  system: TextBlockParam[]
  systemForAttribution: (attribution: string) => TextBlockParam[]
  allTools: BetaToolUnion[]
} {
  let messagesForAPI =
    fittedImages.firstEdited === -1
      ? fittedImages.messages
      : stripThinkingFromIndex(fittedImages.messages, fittedImages.firstEdited)
  messagesForAPI = stripDeadThinking(messagesForAPI, deadThinkingMarks(messages))
  if (thinkingConfig.type === 'disabled') {
    messagesForAPI = stripThinkingFromIndex(messagesForAPI, 0)
  }

  const fingerprint = computeFingerprintFromMessages(messages)
  const prefixKey = conversationRosterKey(rosterOwnerKey, messages, options.model)
  const turnOwning = isTurnOwningQuerySource(options.querySource)
  if (turnOwning) {
    noteCacheClockPrefix(prefixKey)
  }
  const attributionLine = getAttributionHeader(fingerprint)

  const enablePromptCaching = options.enablePromptCaching ?? getPromptCachingEnabled(options.model)
  const systemForAttribution = (attribution: string): TextBlockParam[] =>
    buildTurnSystemBlocks(attribution, systemPrompt, enablePromptCaching)
  const system = systemForAttribution(attributionLine)

  const allTools: BetaToolUnion[] = [...toolSchemas]
  if (options.extraToolSchemas?.length) {
    allTools.push(...options.extraToolSchemas)
  }
  if (options.nativeWebSearch) {
    const searchTool: BetaToolUnion = {
      type: 'web_search_20250305',
      name: 'web_search',
      ...(options.nativeWebSearch.allowedDomains?.length
        ? { allowed_domains: options.nativeWebSearch.allowedDomains }
        : {}),
      ...(options.nativeWebSearch.blockedDomains?.length
        ? { blocked_domains: options.nativeWebSearch.blockedDomains }
        : {}),
      max_uses: options.nativeWebSearch.maxUses,
    }
    allTools.push(searchTool)
  }

  const currentThinkingPrefix = thinkingCarryRides() ? thinkingPrefixDigest(system, allTools) : undefined
  const droppedMarks = droppedThinkingMarks(messages)
  messagesForAPI = stripThinkingFromOtherModels(
    messagesForAPI,
    options.model,
    (_writer, target, row) => carriesThinking(row, target, currentThinkingPrefix, droppedMarks),
  )

  return {
    messagesForAPI,
    fingerprint,
    prefixKey,
    turnOwning,
    attributionLine,
    system,
    systemForAttribution,
    allTools,
  }
}
