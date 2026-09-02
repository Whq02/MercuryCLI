import Anthropic from '@anthropic-ai/sdk'

import type { Message } from '../types/message.js'
import { logError } from '../utils/log.js'
import { normalizeAttachmentForAPI } from '../utils/messages.js'
import { normalizeMessagesForAPI } from '../utils/messages.js'
import { getMainLoopModel, getSmallFastModel, normalizeModelStringForAPI } from '../utils/model/model.js'
import { getModelBetas } from '../utils/betas.js'
import { jsonStringify } from '../utils/slowOperations.js'
import { isToolReferenceBlock } from '../utils/toolSearch.js'
import { getAnthropicClient } from './api/client.js'
import { getAPIMetadata, getExtraBodyParams } from './providers/anthropic/index.js'
import { declaredRouteOf } from './providers/routeLaw.js'
import { withTokenCountVCR } from './vcr.js'


const THINKING_BUDGET_TOKENS = 1024
const PLACEHOLDER_MESSAGES = [{ role: 'user' as const, content: 'hi' }]

function firstPartyCountApplies(): boolean {
  return declaredRouteOf(getMainLoopModel()) === 'anthropic'
}

type CountableMessages = ReturnType<typeof normalizeMessagesForAPI>

function hasThinkingBlocks(messages: ReadonlyArray<{ role?: string; content?: unknown }>): boolean {
  for (const message of messages) {
    if ((message as { role?: string }).role !== 'assistant') continue
    const content = (message as { content?: unknown }).content
    if (!Array.isArray(content)) continue
    for (const block of content) {
      const type = (block as { type?: string }).type
      if (type === 'thinking' || type === 'redacted_thinking') return true
    }
  }
  return false
}

function apiMessagesFor(messages: Message[]): Array<{ role: string; content: unknown }> {
  return normalizeMessagesForAPI(messages).map(message => ({
    role: message.message.role,
    content: message.message.content,
  }))
}

type CountableMessage = Message | { role: string; content: unknown }

function toProductMessage(message: CountableMessage): Message {
  if ('type' in message) return message
  return {
    type: message.role === 'assistant' ? 'assistant' : 'user',
    message: { role: message.role, content: message.content },
  } as unknown as Message
}

export async function countMessagesTokensWithAPI(
  rawMessages: CountableMessage[],
  tools: unknown[],
): Promise<number | null> {
  if (!firstPartyCountApplies()) return null
  const messages = rawMessages.map(toProductMessage)
  return withTokenCountVCR(messages, tools, async () => {
    try {
      const model = normalizeModelStringForAPI(getMainLoopModel())
      const apiMessages = apiMessagesFor(messages)
      const body = apiMessages.length === 0 ? PLACEHOLDER_MESSAGES : apiMessages
      const thinking = hasThinkingBlocks(body)
      const betas = getModelBetas(model)
      const client = await getAnthropicClient({ maxRetries: 1, source: 'count_tokens' })
      const response = await client.beta.messages.countTokens({
        model,
        messages: body as never,
        tools: tools as never,
        ...(betas.length > 0 ? { betas } : {}),
        ...(thinking
          ? { thinking: { type: 'enabled', budget_tokens: THINKING_BUDGET_TOKENS } }
          : {}),
      })
      const count = (response as { input_tokens?: unknown }).input_tokens
      return typeof count === 'number' ? count : null
    } catch (err) {
      logError(err)
      return null
    }
  })
}

export async function countTokensWithAPI(content: string): Promise<number | null> {
  if (content === '') return 0
  const message = {
    type: 'user',
    message: { role: 'user', content },
  } as unknown as Message
  return countMessagesTokensWithAPI([message], [])
}


type LooseBlock = Record<string, unknown>

function stripToolSearchFields(
  messages: Array<{ role: string; content: unknown }>,
): Array<{ role: string; content: unknown }> {
  return messages.map(message => {
    const content = message.content
    if (!Array.isArray(content)) return message
    const rebuilt = content.map(block => {
      const record = block as LooseBlock
      if (record.type === 'tool_use') {
        return { type: 'tool_use', id: record.id, name: record.name, input: record.input }
      }
      if (record.type === 'tool_result' && Array.isArray(record.content)) {
        const kept = (record.content as LooseBlock[]).filter(
          inner => !isToolReferenceBlock(inner),
        )
        if (kept.length === record.content.length) return record
        if (kept.length === 0) {
          return {
            ...record,
            content: [{ type: 'text', text: '[tool references removed]' }],
          }
        }
        return { ...record, content: kept }
      }
      return record
    })
    return { ...message, content: rebuilt }
  })
}

export async function countTokensViaHaikuFallback(
  rawMessages: CountableMessage[],
  tools: unknown[],
): Promise<number | null> {
  if (!firstPartyCountApplies()) return null
  const messages = rawMessages.map(toProductMessage)
  const apiMessages = apiMessagesFor(messages)
  const body = stripToolSearchFields(apiMessages.length === 0 ? PLACEHOLDER_MESSAGES : apiMessages)
  const thinking = hasThinkingBlocks(body)
  const model = getSmallFastModel()
  const betas = getModelBetas(model)
  const client = await getAnthropicClient({ maxRetries: 1, source: 'count_tokens' })
  const response = await client.beta.messages.create({
    model,
    messages: body as never,
    max_tokens: thinking ? 2048 : 1,
    metadata: getAPIMetadata(),
    ...getExtraBodyParams(betas),
    ...(Array.isArray(tools) && tools.length > 0 ? { tools: tools as never } : {}),
    ...(betas.length > 0 ? { betas } : {}),
    ...(thinking ? { thinking: { type: 'enabled', budget_tokens: THINKING_BUDGET_TOKENS } } : {}),
  })
  const usage = (response as unknown as { usage?: Record<string, number | undefined> }).usage
  if (!usage || typeof usage.input_tokens !== 'number') return null
  try {
    const [{ addToTotalSessionCost }, { calculateUSDCost }, { EMPTY_USAGE }] = await Promise.all([
      import('../cost-tracker.js'),
      import('../utils/modelCost.js'),
      import('./api/emptyUsage.js'),
    ])
    const billed = {
      ...EMPTY_USAGE,
      input_tokens: usage.input_tokens,
      output_tokens: usage.output_tokens ?? 0,
      cache_creation_input_tokens: usage.cache_creation_input_tokens ?? 0,
      cache_read_input_tokens: usage.cache_read_input_tokens ?? 0,
    }
    addToTotalSessionCost(calculateUSDCost(model, billed), billed, model)
  } catch (err) {
    logError(err)
  }
  return (
    usage.input_tokens +
    (usage.cache_creation_input_tokens ?? 0) +
    (usage.cache_read_input_tokens ?? 0)
  )
}


const DEFAULT_BYTES_PER_TOKEN = 4
const MEDIA_BLOCK_TOKENS = 2000

export function roughTokenCountEstimation(content: string, bytesPerToken?: number): number {
  return Math.round(content.length / (bytesPerToken ?? DEFAULT_BYTES_PER_TOKEN))
}

export function bytesPerTokenForFileType(ext: string): number {
  return ext === 'json' || ext === 'jsonl' || ext === 'jsonc' ? 2 : DEFAULT_BYTES_PER_TOKEN
}

export function roughTokenCountEstimationForFileType(content: string, ext: string): number {
  return roughTokenCountEstimation(content, bytesPerTokenForFileType(ext))
}

function estimateBlock(block: unknown): number {
  if (typeof block === 'string') return roughTokenCountEstimation(block)
  if (typeof block !== 'object' || block === null) return 0
  const record = block as LooseBlock
  switch (record.type) {
    case 'text':
      return roughTokenCountEstimation(String(record.text ?? ''))
    case 'image':
    case 'document':
      return MEDIA_BLOCK_TOKENS
    case 'tool_result':
      return estimateContent(record.content)
    case 'tool_use':
      return roughTokenCountEstimation(`${String(record.name ?? '')}${jsonStringify(record.input)}`)
    case 'thinking':
      return roughTokenCountEstimation(String(record.thinking ?? ''))
    case 'redacted_thinking':
      return roughTokenCountEstimation(String(record.data ?? ''))
    default:
      return roughTokenCountEstimation(jsonStringify(record) ?? '')
  }
}

function estimateContent(content: unknown): number {
  if (typeof content === 'string') return roughTokenCountEstimation(content)
  if (!Array.isArray(content)) return 0
  let total = 0
  for (const block of content) total += estimateBlock(block)
  return total
}

export function roughTokenCountEstimationForMessage(message: Message): number {
  if (message.type === 'assistant' || message.type === 'user') {
    return estimateContent(message.message.content)
  }
  if (message.type === 'attachment') {
    const normalized = normalizeAttachmentForAPI(message as never) as unknown
    if (Array.isArray(normalized)) {
      let total = 0
      for (const entry of normalized) {
        total += roughTokenCountEstimationForMessage(entry as Message)
      }
      return total
    }
    if (normalized) return roughTokenCountEstimationForMessage(normalized as Message)
    return 0
  }
  return 0
}

export function roughTokenCountEstimationForMessages(messages: Message[]): number {
  let total = 0
  for (const message of messages) total += roughTokenCountEstimationForMessage(message)
  return total
}

export type TokenCountingSdk = typeof Anthropic
