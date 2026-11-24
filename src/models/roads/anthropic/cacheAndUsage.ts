import type { MessageParam, TextBlockParam } from '../../../engine/message-shapes/wire.js'
import type { AnthropicStream } from './anthropicStream.js'
import { isWholeRecordedComposition } from '../../../engine/system-prompt/recordedComposition.js'
import {
  type AssistantMessage,
  type UserMessage,
} from '../../../engine/message-shapes/message.js'
import type { ApiMessageDeltaUsage, ApiUsage } from '../../../engine/message-shapes/wire.js'
import { splitSystemPromptBlocks } from '../../../engine/messages/apiSystemAndToolSchema.js'
import { asSystemPrompt, type SystemPrompt } from '../../../engine/system-prompt/systemPromptType.js'
import { type NonNullableUsage } from '../../../engine/requests/apiCallLogging.js'
import { assistantMessageToMessageParam, userMessageToMessageParam } from './messageParams.js'
import { getCacheControl } from './requestParams.js'
import { normalizeAnthropicToolIds } from './toolIds.js'
import { passedOver } from '../../../platform/errors/passedOver.js'

export function buildSystemPromptBlocks(systemPrompt: SystemPrompt, enablePromptCaching: boolean): TextBlockParam[] {
  return splitSystemPromptBlocks(systemPrompt).map(block => ({
    type: 'text',
    text: block.text,
    ...(enablePromptCaching && block.cached ? { cache_control: getCacheControl() } : {}),
  }))
}

export function assembleTurnSystemPrompt(
  attribution: string,
  systemPrompt: SystemPrompt,
): SystemPrompt {
  if (isWholeRecordedComposition(systemPrompt)) return systemPrompt
  return asSystemPrompt([attribution, ...systemPrompt].filter(Boolean))
}

export function buildTurnSystemBlocks(attribution: string, systemPrompt: SystemPrompt, enablePromptCaching: boolean): TextBlockParam[] {
  return buildSystemPromptBlocks(assembleTurnSystemPrompt(attribution, systemPrompt), enablePromptCaching)
}

export function addCacheBreakpoints(
  messages: (UserMessage | AssistantMessage)[],
  enablePromptCaching: boolean,
  skipCacheWrite: boolean = false,
): MessageParam[] {
  let markerIndex = messages.length - 1
  if (skipCacheWrite) {
    markerIndex = -1
    for (let i = messages.length - 2; i >= 0; i--) {
      if (messages[i]?.type === 'user') {
        markerIndex = i
        break
      }
    }
  }

  const result: MessageParam[] = messages.map((msg, index) => {
    const shouldMark = index === markerIndex
    return msg.type === 'user'
      ? userMessageToMessageParam(msg, shouldMark, enablePromptCaching)
      : assistantMessageToMessageParam(msg, shouldMark, enablePromptCaching)
  })

  return normalizeAnthropicToolIds(result)
}

const positive = (incoming: number | null | undefined, before: number): number => incoming != null && incoming > 0 ? incoming : before
const cacheCounters = ['ephemeral_1h_input_tokens', 'ephemeral_5m_input_tokens'] as const

function usageGroup<K extends string>(
  keys: readonly K[], before: () => Record<K, number>,
  incoming: () => Partial<Record<K, number | null>> | null | undefined, adding: boolean,
): Record<K, number> {
  return Object.fromEntries(keys.map(key => [key, adding
    ? before()[key] + incoming()![key]!
    : incoming()?.[key] ?? before()[key]])) as Record<K, number>
}

function foldUsage(before: Readonly<NonNullableUsage>, incoming: ApiMessageDeltaUsage, adding: boolean, server: () => NonNullableUsage['server_tool_use']): NonNullableUsage {
  const wire = incoming as ApiUsage
  const settled = incoming as NonNullableUsage
  const token = (key: 'input_tokens' | 'cache_creation_input_tokens' | 'cache_read_input_tokens'): number => adding
    ? before[key] + incoming[key]!
    : positive(incoming[key], before[key])
  return {
    input_tokens: token('input_tokens'),
    cache_creation_input_tokens: token('cache_creation_input_tokens'),
    cache_read_input_tokens: token('cache_read_input_tokens'),
    output_tokens: adding ? before.output_tokens + incoming.output_tokens! : incoming.output_tokens ?? before.output_tokens,
    server_tool_use: server(),
    service_tier: adding ? settled.service_tier : before.service_tier,
    cache_creation: usageGroup(cacheCounters, () => before.cache_creation, () => wire.cache_creation, adding),
    inference_geo: adding ? settled.inference_geo : before.inference_geo,
    iterations: adding ? settled.iterations : settled.iterations ?? before.iterations,
    speed: adding ? settled.speed : wire.speed ?? before.speed,
    output_tokens_details: adding
      ? before.output_tokens_details || settled.output_tokens_details
        ? { thinking_tokens: (before.output_tokens_details?.thinking_tokens ?? 0) + (settled.output_tokens_details?.thinking_tokens ?? 0) }
        : null
      : wire.output_tokens_details ?? before.output_tokens_details,
  }
}

export function updateUsage(usage: Readonly<NonNullableUsage>, partUsage: ApiMessageDeltaUsage | undefined): NonNullableUsage {
  if (!partUsage) return { ...usage }
  const server = () => ({
    web_search_requests: partUsage.server_tool_use?.web_search_requests ?? usage.server_tool_use.web_search_requests,
    web_fetch_requests: partUsage.server_tool_use?.web_fetch_requests ?? usage.server_tool_use.web_fetch_requests,
  })
  return foldUsage(usage, partUsage, false, server)
}

export function accumulateUsage(totalUsage: Readonly<NonNullableUsage>, messageUsage: Readonly<NonNullableUsage>): NonNullableUsage {
  const server = () => ({
    web_search_requests: totalUsage.server_tool_use.web_search_requests + messageUsage.server_tool_use.web_search_requests,
    web_fetch_requests: totalUsage.server_tool_use.web_fetch_requests + messageUsage.server_tool_use.web_fetch_requests,
  })
  return foldUsage(totalUsage, messageUsage, true, server)
}

export function usageBeyond(usage: Readonly<NonNullableUsage>, charged: Readonly<NonNullableUsage>): NonNullableUsage {
  const beyond = (now: number, before: number): number => Math.max(0, now - before)
  return {
    ...usage,
    input_tokens: beyond(usage.input_tokens, charged.input_tokens),
    cache_creation_input_tokens: beyond(usage.cache_creation_input_tokens, charged.cache_creation_input_tokens),
    cache_read_input_tokens: beyond(usage.cache_read_input_tokens, charged.cache_read_input_tokens),
    output_tokens: beyond(usage.output_tokens, charged.output_tokens),
    server_tool_use: {
      web_search_requests: beyond(usage.server_tool_use.web_search_requests, charged.server_tool_use.web_search_requests),
      web_fetch_requests: beyond(usage.server_tool_use.web_fetch_requests, charged.server_tool_use.web_fetch_requests),
    },
  }
}

export function cleanupStream(stream: AnthropicStream | undefined): void {
  try {
    const controller = stream?.controller
    if (controller && !controller.signal.aborted) controller.abort()
  } catch (error) { passedOver(error) }
}
