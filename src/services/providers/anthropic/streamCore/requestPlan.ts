import type { ApiToolUnion as BetaToolUnion } from '../../../../types/wire.js'
import { getToolSearchBetaHeader } from 'src/utils/betas.js'
import { noteCacheClockPrefix } from 'src/utils/cache/cacheClock.js'
import { logForDebugging } from 'src/utils/debug.js'
import type { ThinkingConfig } from 'src/utils/thinking.js'
import { getAttributionHeader } from '../../../../constants/system.js'
import type { Tool, Tools } from '../../../../Tool.js'
import {
  ensureGatewayProbe,
  gatewayProbePolicyAllows,
  type GatewayProbeAnswer,
} from '../../deferralProbe.js'
import { gatewayHost } from '../../deferralWire.js'
import { planToolPayload, renderAdmissionRecordsAsText } from '../../toolEconomy.js'
import { declareLawfulPrefixChange } from '../../lawfulPrefixChange.js'
import type { AssistantMessage, Message, UserMessage } from '../../../../types/message.js'
import { toolToAPISchema } from '../../../messages/api.js'
import {
  isToolSearchEnabledOptimistic,
  isToolSearchToolAvailable,
  modelSupportsToolReference,
} from '../../../messages/toolSearch.js'
import {
  normalizeMessagesForAPI,
  stripCallerFieldFromAssistantMessage,
  stripUnsignedThinkingBlocks,
} from '../../../messages.js'
import { stripThinkingFromIndex } from '../../../messages/apiFilters.js'
import { pairConversationMessages } from '../../../messages/pairing.js'
import type { SystemPrompt } from '../../../../utils/systemPromptType.js'
import { retireOlderScreenshots } from '../../../desktop/screenshotRetention.js'
import { getPromptCachingEnabled } from '../requestParams.js'
import type { RequestImageFit } from '../../../../utils/imageResizer.js'
import type { Options } from '../streamCore.js'
import type { AnthropicMessageParams } from '../../../../types/anthropicWire.js'
import { notBuilt, type Unbuilt } from '../../../../pi/holes.js'

const GATEWAY_PROBE_TIMEOUT_MS = 8_000
async function sendGatewayProbe(
  body: AnthropicMessageParams,
  betaHeader: string,
  options: Options,
): Promise<GatewayProbeAnswer> {
  return notBuilt('src/services/providers/anthropic/streamCore/requestPlan.ts:48')
}

function withoutToolSearchFields(message: UserMessage | AssistantMessage): UserMessage | AssistantMessage {
  return notBuilt('src/services/providers/anthropic/streamCore/requestPlan.ts:76')
}

export function requestBetas(options: Options): Unbuilt {
  return notBuilt('src/services/providers/anthropic/streamCore/requestPlan.ts:82')
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
): Unbuilt {
  return notBuilt('src/services/providers/anthropic/streamCore/requestPlan.ts:163')
}
