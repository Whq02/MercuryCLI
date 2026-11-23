import type { Message } from '../types/message.js'
import type { ApiToolUnion, ContentBlock, ContentBlockParam, MessageParam, TextBlockParam } from '../types/wire.js'
import { logForDebugging } from '../utils/debug.js'
import { logError } from '../utils/log.js'
import { isRecord } from '../utils/isRecord.js'
import { createAssistantMessage, createUserMessage } from '../utils/messages/factories.js'
import { normalizeMessagesForAPI } from './messages.js'
import { getDefaultSonnetModel, getEngineModel, normalizeModelStringForAPI } from './model/model.js'
import { utilityCallFor } from './model/utilityModel.js'
import { getModelBetas } from '../utils/betas.js'
import { sideQuery } from './api/sideQuery.js'
import { sleep } from '../utils/sleep.js'
import { modelSupportsAdaptiveThinking } from '../utils/thinking.js'
import { modelSupportsEffort } from '../utils/effort.js'
import { isToolReferenceBlock } from './messages/toolSearch.js'
import { getAnthropicClient } from './api/client.js'
import { outageCauseOf, outageCauseWords } from './api/reconnectLadder.js'
import { isSpentUsageWindowAnswer, providerAskedWaitMs, providerWaitIsWindow, retrySeconds } from './api/recoveryBudget.js'
import { APIConnectionError, APIConnectionTimeoutError } from '../utils/api/sdkErrors.js'
import { is529Error, isRetryableError, isStaleConnectionError } from './api/withRetry.js'
import { busyRetryScale, nextBusyRetryWithinBudget, openBusyRetryLadder } from './providers/busyRetry.js'
import { declaredRouteOf } from './providers/routeLaw.js'
import { withTokenCountVCR } from './vcr.js'
export { roughTokenCountEstimation, bytesPerTokenForFileType, roughTokenCountEstimationForFileType, estimateContentTokens, roughTokenCountEstimationForMessages, estimateRequestTokens } from './roughTokenEstimation.js'


const THINKING_BUDGET_TOKENS = 1024
const PLACEHOLDER_MESSAGES: MessageParam[] = [{ role: 'user', content: 'hi' }]
export const COUNT_RETRY_BUDGET_MS = 15_000
const COUNT_SOURCE = 'count_tokens'

function firstPartyCountApplies(): boolean {
  return declaredRouteOf(getEngineModel()) === 'anthropic'
}

function countProbeCall(): { model: string; effort: string | undefined } {
  const seat = utilityCallFor().model
  const model = normalizeModelStringForAPI(declaredRouteOf(seat) === 'anthropic' ? seat : getDefaultSonnetModel())
  const { effortValue } = utilityCallFor(model)
  return { model, effort: effortValue !== undefined && modelSupportsEffort(model) ? String(effortValue) : undefined }
}

function refusalWords(error: unknown): string {
  const record = isRecord(error) ? error : null
  const status = typeof record?.status === 'number' ? `HTTP ${record.status}` : 'no status'
  const message = typeof record?.message === 'string' ? record.message.replace(/\s+/g, ' ').trim().slice(0, 200) : ''
  return message === '' ? status : `${status}: ${message}`
}

function countRetryRefusal(error: unknown, askedMs: number | undefined): string | null {
  if (error instanceof APIConnectionTimeoutError) return `no answer within the count's ${retrySeconds(COUNT_RETRY_BUDGET_MS)} — a stalled count is not retried`
  const outage = outageCauseOf(error)
  if (outage !== null) return `${outageCauseWords(outage)}: nothing answers at the provider's address, and a count is not waited for`
  if (error instanceof APIConnectionError && !isStaleConnectionError(error)) return "connection error: nothing answers at the provider's address, and a count is not waited for"
  if (is529Error(error)) return 'an overload is not retried by a count (nobody waits on it; retries multiply the load)'
  if (isSpentUsageWindowAnswer(error)) return 'the usage window is spent'
  if (providerWaitIsWindow(askedMs)) return `the provider asked for ${retrySeconds(askedMs ?? 0)} — its usage window, not a burst`
  if (!isRetryableError(error)) return 'not a retryable refusal'
  return null
}

async function countWithBusyRetry<T>(road: string, run: () => Promise<T>): Promise<T> {
  const ladder = openBusyRetryLadder(Date.now(), busyRetryScale(), COUNT_RETRY_BUDGET_MS)
  for (;;) {
    try {
      return await run()
    } catch (error) {
      const asked = providerAskedWaitMs(error)
      const askedWords = asked === undefined ? '' : ` (the provider asked for ${retrySeconds(asked)})`
      const refusal = countRetryRefusal(error, asked)
      if (refusal !== null) {
        logForDebugging(`${road}: ${refusalWords(error)} — not retried: ${refusal}; the caller keeps its estimate`, { level: 'warn' })
        throw error
      }
      const step = nextBusyRetryWithinBudget(ladder, asked, Date.now())
      if (step === null) {
        const retries = ladder.waitsMs.length
        logForDebugging(`${road}: ${refusalWords(error)} — the count's ${retrySeconds(ladder.budgetMs)} retry budget is spent after ${retries} retr${retries === 1 ? 'y' : 'ies'}${askedWords}; the caller keeps its estimate`, { level: 'warn' })
        throw error
      }
      logForDebugging(`${road}: ${refusalWords(error)} — waiting ${retrySeconds(step.waitMs)} before retry ${step.attempt} of ${step.of}${askedWords}`, { level: 'warn' })
      await sleep(step.waitMs)
    }
  }
}

function hasThinkingBlocks(messages: readonly MessageParam[]): boolean {
  for (const message of messages) {
    if (message.role !== 'assistant' || !Array.isArray(message.content)) continue
    for (const block of message.content) {
      if (block.type === 'thinking' || block.type === 'redacted_thinking') return true
    }
  }
  return false
}

function apiMessagesFor(messages: Message[]): MessageParam[] {
  return normalizeMessagesForAPI(messages).map(message => ({
    role: message.message.role,
    content: message.message.content,
  }))
}

type CountableMessage = { role: 'user' | 'assistant'; content: unknown }

function isBlockArray<T>(value: unknown): value is T[] {
  return Array.isArray(value)
}

function toProductMessage(message: CountableMessage): Message {
  if (message.role === 'assistant') {
    const content =
      typeof message.content === 'string'
        ? message.content
        : isBlockArray<ContentBlock>(message.content)
          ? message.content
          : []
    return createAssistantMessage({ content })
  }
  const content =
    typeof message.content === 'string'
      ? message.content
      : isBlockArray<ContentBlockParam>(message.content)
        ? message.content
        : []
  return createUserMessage({ content })
}

export async function countMessagesTokensWithAPI(
  rawMessages: CountableMessage[],
  tools: ApiToolUnion[],
  system?: readonly TextBlockParam[],
): Promise<number | null> {
  if (!firstPartyCountApplies()) return null
  const messages = rawMessages.map(toProductMessage)
  const systemBlocks = system && system.length > 0 ? system : undefined
  return withTokenCountVCR(messages, tools, systemBlocks, async () => {
    try {
      const apiMessages = apiMessagesFor(messages)
      const body = apiMessages.length === 0 ? PLACEHOLDER_MESSAGES : apiMessages
      const model = normalizeModelStringForAPI(getEngineModel())
      const betas = getModelBetas(model)
      const thinking = hasThinkingBlocks(body)
      const thinkingOption = thinking
        ? modelSupportsAdaptiveThinking(model)
          ? { type: 'adaptive' as const }
          : { type: 'enabled' as const, budget_tokens: THINKING_BUDGET_TOKENS }
        : undefined
      const client = await getAnthropicClient({ maxRetries: 0, source: COUNT_SOURCE })
      const response = await countWithBusyRetry(COUNT_SOURCE, () =>
        client.beta.messages.countTokens(
          {
            model,
            messages: body,
            tools,
            ...(systemBlocks ? { system: systemBlocks } : {}),
            ...(betas.length > 0 ? { betas } : {}),
            ...(thinkingOption ? { thinking: thinkingOption } : {}),
          },
          { timeout: COUNT_RETRY_BUDGET_MS },
        ),
      )
      return typeof response?.input_tokens === 'number' ? response.input_tokens : null
    } catch (error) {
      logError(error)
      return null
    }
  })
}

export async function countTokensWithAPI(content: string): Promise<number | null> {
  if (!content) return 0
  return countMessagesTokensWithAPI([{ role: 'user', content }], [])
}

function stripToolSearchFields(messages: MessageParam[]): MessageParam[] {
  return messages.map(message => {
    if (typeof message.content === 'string') return message
    const content = message.content.map(block => {
      if (block.type === 'tool_use') {
        return {
          type: block.type,
          id: block.id,
          name: block.name,
          input: block.input,
        }
      }
      if (block.type === 'tool_result' && Array.isArray(block.content)) {
        const filtered = block.content.filter(item => !isToolReferenceBlock(item))
        if (filtered.length === block.content.length) return block
        return {
          ...block,
          content:
            filtered.length === 0
              ? [{ type: 'text' as const, text: '[tool references removed]' }]
              : filtered,
        }
      }
      return block
    })
    return { ...message, content }
  })
}

export async function countTokensViaHaikuFallback(
  rawMessages: CountableMessage[],
  tools: ApiToolUnion[],
): Promise<number | null> {
  if (!firstPartyCountApplies()) return null
  const messages = rawMessages.map(toProductMessage)
  const apiMessages = apiMessagesFor(messages)
  const body = stripToolSearchFields(apiMessages.length === 0 ? PLACEHOLDER_MESSAGES : apiMessages)
  const thinking = hasThinkingBlocks(body)
  const { model, effort } = countProbeCall()
  const response = await countWithBusyRetry(`${COUNT_SOURCE} (create probe)`, () =>
    sideQuery({
      model,
      messages: body,
      max_tokens: thinking ? 2048 : 1,
      ...(Array.isArray(tools) && tools.length > 0 ? { tools } : {}),
      thinking: thinking ? THINKING_BUDGET_TOKENS : false,
      ...(effort !== undefined ? { effort } : {}),
      maxRetries: 0,
      querySource: COUNT_SOURCE,
      source: COUNT_SOURCE,
    }),
  )
  const usage = response.usage
  if (!usage || typeof usage.input_tokens !== 'number') return null
  try {
    const [{ addToTotalSessionCost }, { calculateUSDCost }, { EMPTY_USAGE }] = await Promise.all([
      import('../cost-tracker.js'),
      import('./usage/modelCost.js'),
      import('../utils/api/emptyUsage.js'),
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
