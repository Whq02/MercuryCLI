import type { MessageParam, TextBlockParam } from '../../../types/wire.js'
import type { AnthropicStream } from './anthropicStream.js'
import { logForDebugging } from 'src/utils/debug.js'
import { isWholeRecordedComposition } from '../../../prompt/recordedComposition.js'
import {
  type AssistantMessage,
  type UserMessage,
} from '../../../types/message.js'
import type { ApiMessageDeltaUsage, ApiUsage } from '../../../types/wire.js'
import { splitSystemPromptBlocks } from '../../messages/api.js'
import { insertBlockAfterToolResults } from '../../../utils/contentArray.js'
import { asSystemPrompt, type SystemPrompt } from '../../../utils/systemPromptType.js'
import { pinCacheEdits } from '../../compact/microCompact.js'
import { type NonNullableUsage } from '../../api/logging.js'
import { assistantMessageToMessageParam, userMessageToMessageParam } from './messageParams.js'
import { getCacheControl } from './requestParams.js'
import { normalizeAnthropicToolIds } from './toolIds.js'
import { passedOver } from '../../../utils/passedOver.js'

export type CachedMCEditsBlock = {
  type: 'cache_edits'
  edits: Array<{
    type: 'delete'
    cache_reference: string
  }>
}

export type CachedMCPinnedEdits = {
  userMessageIndex: number
  block: CachedMCEditsBlock
}

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
  useCachedMC: boolean = false,
  newCacheEdits?: CachedMCEditsBlock | null,
  pinnedEdits?: CachedMCPinnedEdits[],
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

  if (useCachedMC) {
    const seenRefs = new Set<string>()
    const dedupBlock = (block: CachedMCEditsBlock): CachedMCEditsBlock | null => {
      const unique = block.edits.filter(edit => {
        if (seenRefs.has(edit.cache_reference)) return false
        seenRefs.add(edit.cache_reference)
        return true
      })
      if (unique.length === 0) return null
      return { ...block, edits: unique }
    }
    const ensureContentArray = (msg: MessageParam): Exclude<MessageParam['content'], string> => {
      if (Array.isArray(msg.content)) return msg.content
      const arr: Exclude<MessageParam['content'], string> = [{ type: 'text', text: msg.content }]
      msg.content = arr
      return arr
    }

    if (pinnedEdits) {
      for (const pin of pinnedEdits) {
        const target = result[pin.userMessageIndex]
        if (!target || target.role !== 'user') continue
        const deduped = dedupBlock(pin.block)
        if (!deduped) continue
        insertBlockAfterToolResults(ensureContentArray(target), deduped)
      }
    }

    if (newCacheEdits && newCacheEdits.edits.length > 0) {
      let lastUserIndex = -1
      for (let i = result.length - 1; i >= 0; i--) {
        if (result[i]?.role === 'user') {
          lastUserIndex = i
          break
        }
      }
      if (lastUserIndex !== -1) {
        const deduped = dedupBlock(newCacheEdits)
        if (deduped) {
          insertBlockAfterToolResults(ensureContentArray(result[lastUserIndex]!), deduped)
          pinCacheEdits(lastUserIndex, newCacheEdits)
          logForDebugging(
            `cache edits on message[${lastUserIndex}]: ${deduped.edits.length} deleted — ${deduped.edits.map(e => e.cache_reference).join(', ')}`,
          )
        }
      }
    }

    if (enablePromptCaching) {
      let lastMarkerIndex = -1
      for (let i = result.length - 1; i >= 0; i--) {
        const content = result[i]?.content
        if (
          Array.isArray(content) &&
          content.some(
            block => block != null && typeof block === 'object' && (block as { cache_control?: unknown }).cache_control != null,
          )
        ) {
          lastMarkerIndex = i
          break
        }
      }
      for (let i = 0; i < lastMarkerIndex; i++) {
        const msg = result[i]
        if (!msg || msg.role !== 'user' || !Array.isArray(msg.content)) continue
        const stamped: Exclude<MessageParam['content'], string> = []
        for (let j = 0; j < msg.content.length; j++) {
          const block = msg.content[j]
          if (block != null && typeof block === 'object' && block.type === 'tool_result' && block.tool_use_id) {
            stamped.push({ ...block, cache_reference: block.tool_use_id } as typeof block)
          } else {
            stamped.push(block)
          }
        }
        msg.content = stamped
      }
    }
  }

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

export function cleanupStream(stream: AnthropicStream | undefined): void {
  try {
    const controller = stream?.controller
    if (controller && !controller.signal.aborted) controller.abort()
  } catch (error) { passedOver(error) }
}
