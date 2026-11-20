import type { Message } from '../types/message.js'
import type { ApiToolUnion, ContentBlockParam, MessageParam, TextBlockParam } from '../types/wire.js'
import { logForDebugging } from '../utils/debug.js'
import { logError } from '../utils/log.js'
import { normalizeMessagesForAPI } from '../utils/messages.js'
import { getDefaultSonnetModel, getEngineModel, normalizeModelStringForAPI } from '../utils/model/model.js'
import { utilityCallFor } from '../utils/model/utilityModel.js'
import { getModelBetas } from '../utils/betas.js'
import { sideQuery } from './api/sideQuery.js'
import { sleep } from '../utils/sleep.js'
import { modelSupportsAdaptiveThinking } from '../utils/thinking.js'
import { modelSupportsEffort } from '../utils/effort.js'
import { isToolReferenceBlock } from '../utils/toolSearch.js'
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
  const record = error as { status?: unknown; message?: unknown } | null
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

function apiMessagesFor(messages: Message[]): MessageParam[] {
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
  tools: ApiToolUnion[],
  system?: readonly TextBlockParam[],
): Promise<number | null> {
  if (!firstPartyCountApplies()) return null
  const messages = rawMessages.map(toProductMessage)
  const carried = system !== undefined && system.length > 0 ? system : undefined
  return withTokenCountVCR(messages, tools, carried, async () => {
    try {
      const model = normalizeModelStringForAPI(getEngineModel())
      const apiMessages = apiMessagesFor(messages)
      const body = apiMessages.length === 0 ? PLACEHOLDER_MESSAGES : apiMessages
      const thinking = hasThinkingBlocks(body)
      const betas = getModelBetas(model)
      const client = await getAnthropicClient({ maxRetries: 0, source: COUNT_SOURCE })
      const response = await countWithBusyRetry(COUNT_SOURCE, () =>
        client.beta.messages.countTokens(
          {
            model,
            messages: body,
            tools,
            ...(carried !== undefined ? { system: carried } : {}),
            ...(betas.length > 0 ? { betas } : {}),
            ...(thinking
              ? {
                  thinking: modelSupportsAdaptiveThinking(model)
                    ? { type: 'adaptive' }
                    : { type: 'enabled', budget_tokens: THINKING_BUDGET_TOKENS },
                }
              : {}),
          },
          { timeout: COUNT_RETRY_BUDGET_MS },
        ),
      )
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
  return countMessagesTokensWithAPI([{ role: 'user', content }], [])
}


function stripToolSearchFields(messages: MessageParam[]): MessageParam[] {
  return messages.map(message => {
    const content = message.content
    if (!Array.isArray(content)) return message
    const rebuilt = content.map((block): ContentBlockParam => {
      if (block.type === 'tool_use') {
        return { type: 'tool_use', id: block.id, name: block.name, input: block.input }
      }
      if (block.type === 'tool_result' && Array.isArray(block.content)) {
        const kept = block.content.filter(
          inner => !isToolReferenceBlock(inner),
        )
        if (kept.length === block.content.length) return block
        if (kept.length === 0) {
          return {
            ...block,
            content: [{ type: 'text', text: '[tool references removed]' }],
          }
        }
        return { ...block, content: kept }
      }
      return block
    })
    return { ...message, content: rebuilt }
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
