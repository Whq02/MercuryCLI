import { type BetaMessageParam as MessageParam, type BetaRawMessageStreamEvent } from '@anthropic-ai/sdk/resources/beta/messages/messages.mjs'
import { type TextBlockParam } from '@anthropic-ai/sdk/resources/index.mjs'
import { type Stream } from '@anthropic-ai/sdk/streaming.mjs'
import { logForDebugging } from 'src/utils/debug.js'
import { type AssistantMessage, type UserMessage } from '../../../types/message.js'
import type { ApiMessageDeltaUsage, ApiUsage } from '../../../types/wire.js'
import { splitSystemPromptBlocks } from '../../../utils/api.js'
import { insertBlockAfterToolResults } from '../../../utils/contentArray.js'
import { asSystemPrompt, type SystemPrompt } from '../../../utils/systemPromptType.js'
import { pinCacheEdits } from '../../compact/microCompact.js'
import { type NonNullableUsage } from '../../api/logging.js'
import { assistantMessageToMessageParam, userMessageToMessageParam } from './messageParams.js'
import { getCacheControl } from './requestParams.js'

export type CachedMCEditsBlock = { type: 'cache_edits'; edits: { type: 'delete'; cache_reference: string }[] }
export type CachedMCPinnedEdits = { userMessageIndex: number; block: CachedMCEditsBlock }

export function buildSystemPromptBlocks(systemPrompt: SystemPrompt, enablePromptCaching: boolean): TextBlockParam[] {
  return splitSystemPromptBlocks(systemPrompt).map(({ text, cached }) => {
    const block: TextBlockParam = { type: 'text', text }
    if (enablePromptCaching && cached) block.cache_control = getCacheControl()
    return block
  })
}

export function buildTurnSystemBlocks(attribution: string, systemPrompt: SystemPrompt, enablePromptCaching: boolean): TextBlockParam[] {
  const assembled = assembleTurnSystemPrompt(attribution, systemPrompt)
  return buildSystemPromptBlocks(assembled, enablePromptCaching)
}

export function isToolResultBlock(block: unknown): block is { type: 'tool_result'; tool_use_id: string } {
  if (block === null || typeof block !== 'object') return false
  return 'type' in block && block.type === 'tool_result' && 'tool_use_id' in block
}

function editDeduplicator(): (block: CachedMCEditsBlock) => CachedMCEditsBlock {
  const deleted = new Set<string>()
  return block => {
    const edits: CachedMCEditsBlock['edits'] = []
    for (const edit of block.edits) {
      if (deleted.has(edit.cache_reference)) continue
      deleted.add(edit.cache_reference)
      edits.push(edit)
    }
    return { ...block, edits }
  }
}

function arrayContent(row: MessageParam): Exclude<MessageParam['content'], string> {
  if (!Array.isArray(row.content)) row.content = [{ type: 'text', text: row.content as string }]
  return row.content
}

function replayCacheEdits(rows: MessageParam[], pinned: CachedMCPinnedEdits[], fresh?: CachedMCEditsBlock | null): void {
  const unique = editDeduplicator()
  for (const placement of pinned) {
    const row = rows[placement.userMessageIndex]
    if (row?.role !== 'user') continue
    const content = arrayContent(row)
    const block = unique(placement.block)
    if (block.edits.length) insertBlockAfterToolResults(content, block)
  }
  if (!fresh || !rows.length) return
  const block = unique(fresh)
  if (!block.edits.length) return
  const index = rows.findLastIndex(row => row?.role === 'user')
  const row = rows[index]
  if (!row) return
  insertBlockAfterToolResults(arrayContent(row), block)
  pinCacheEdits(index, fresh)
  logForDebugging(`cache edits on message[${index}]: ${block.edits.length} deleted — ${block.edits.map(edit => edit.cache_reference).join(', ')}`)
}

function stampCachedResults(rows: MessageParam[]): void {
  const marker = rows.findLastIndex(row => Array.isArray(row.content) && row.content.some(block =>
    block && typeof block === 'object' && 'cache_control' in block))
  for (let index = 0; index < marker; index++) {
    const row = rows[index]!
    const content = row.content
    if (row.role !== 'user' || !Array.isArray(content) || !content.some(isToolResultBlock)) continue
    row.content = content.map(block => isToolResultBlock(block) ? { ...block, cache_reference: block.tool_use_id } : block)
  }
}

export function addCacheBreakpoints(
  messages: (UserMessage | AssistantMessage)[], enablePromptCaching: boolean, useCachedMC = false,
  newCacheEdits?: CachedMCEditsBlock | null, pinnedEdits?: CachedMCPinnedEdits[], skipCacheWrite = false,
): MessageParam[] {
  const tail = messages.length - 1
  const marker = skipCacheWrite ? messages.findLastIndex((row, index) => index < tail && row.type === 'user') : tail
  const rows = messages.map((row, index) => row.type === 'user'
    ? userMessageToMessageParam(row, index === marker, enablePromptCaching)
    : assistantMessageToMessageParam(row, index === marker, enablePromptCaching)) as unknown as MessageParam[]
  if (useCachedMC) {
    replayCacheEdits(rows, pinnedEdits ?? [], newCacheEdits)
    if (enablePromptCaching) stampCachedResults(rows)
  }
  return rows
}

const sum = (before: number, incoming: number | null | undefined): number => before + incoming!
const latest = (before: number, incoming: number | null | undefined): number => incoming ?? before
const positive = (before: number, incoming: number | null | undefined): number => incoming != null && incoming > 0 ? incoming : before

type UsageNumberRule = typeof latest
function usageGroup<K extends string>(keys: readonly K[], before: Record<K, number>, incoming: Partial<Record<K, number | null>> | null | undefined, combine: UsageNumberRule): Record<K, number> {
  return Object.fromEntries(keys.map(key => [key, combine(before[key], incoming?.[key])])) as Record<K, number>
}

const cacheCounters = ['ephemeral_1h_input_tokens', 'ephemeral_5m_input_tokens'] as const

function foldUsage(before: Readonly<NonNullableUsage>, incoming: ApiMessageDeltaUsage, adding: boolean, server_tool_use: NonNullableUsage['server_tool_use']): NonNullableUsage {
  const wire = incoming as ApiUsage
  const tokens = adding ? sum : positive
  const combine = adding ? sum : latest
  const settled = incoming as NonNullableUsage
  const details = adding
    ? before.output_tokens_details || settled.output_tokens_details
      ? { thinking_tokens: (before.output_tokens_details?.thinking_tokens ?? 0) + (settled.output_tokens_details?.thinking_tokens ?? 0) }
      : null
    : wire.output_tokens_details ?? before.output_tokens_details
  return {
    input_tokens: tokens(before.input_tokens, incoming.input_tokens),
    cache_creation_input_tokens: tokens(before.cache_creation_input_tokens, incoming.cache_creation_input_tokens),
    cache_read_input_tokens: tokens(before.cache_read_input_tokens, incoming.cache_read_input_tokens),
    output_tokens: combine(before.output_tokens, incoming.output_tokens),
    server_tool_use,
    service_tier: adding ? settled.service_tier : before.service_tier,
    cache_creation: usageGroup(cacheCounters, before.cache_creation, wire.cache_creation, combine),
    inference_geo: adding ? settled.inference_geo : before.inference_geo,
    iterations: adding ? settled.iterations : settled.iterations ?? before.iterations,
    speed: adding ? settled.speed : wire.speed ?? before.speed,
    output_tokens_details: details,
  }
}

export function updateUsage(usage: Readonly<NonNullableUsage>, partUsage: ApiMessageDeltaUsage | undefined): NonNullableUsage {
  if (!partUsage) return { ...usage }
  const server = {
    web_search_requests: partUsage.server_tool_use?.web_search_requests ?? usage.server_tool_use.web_search_requests,
    web_fetch_requests: partUsage.server_tool_use?.web_fetch_requests ?? usage.server_tool_use.web_fetch_requests,
  }
  return foldUsage(usage, partUsage, false, server)
}

export function accumulateUsage(totalUsage: Readonly<NonNullableUsage>, messageUsage: Readonly<NonNullableUsage>): NonNullableUsage {
  const server = {
    web_search_requests: totalUsage.server_tool_use.web_search_requests + messageUsage.server_tool_use.web_search_requests,
    web_fetch_requests: totalUsage.server_tool_use.web_fetch_requests + messageUsage.server_tool_use.web_fetch_requests,
  }
  return foldUsage(totalUsage, messageUsage, true, server)
}

export function cleanupStream(stream: Stream<BetaRawMessageStreamEvent> | undefined): void {
  try {
    const controller = stream?.controller
    if (controller && !controller.signal.aborted) controller.abort()
  } catch {}
}

export function assembleTurnSystemPrompt(
  attribution: string,
  systemPrompt: SystemPrompt,
): SystemPrompt {
  return asSystemPrompt([attribution, ...systemPrompt].filter(Boolean))
}
