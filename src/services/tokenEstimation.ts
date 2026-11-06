import { inflateSync } from 'node:zlib'
import type { Message } from '../types/message.js'
import type { TextBlockParam } from '../types/wire.js'
import { logForDebugging } from '../utils/debug.js'
import { logError } from '../utils/log.js'
import { normalizeAttachmentForAPI } from '../utils/messages.js'
import { normalizeMessagesForAPI } from '../utils/messages.js'
import { getDefaultSonnetModel, getEngineModel, normalizeModelStringForAPI } from '../utils/model/model.js'
import { utilityCallFor } from '../utils/model/utilityModel.js'
import { getModelBetas } from '../utils/betas.js'
import { sideQuery } from '../utils/sideQuery.js'
import { sleep } from '../utils/sleep.js'
import { jsonStringify } from '../utils/slowOperations.js'
import { modelSupportsAdaptiveThinking } from '../utils/thinking.js'
import { modelSupportsEffort } from '../utils/effort.js'
import { modelReceivesImageBlocks } from '../utils/model/capabilities.js'
import { isToolReferenceBlock } from '../utils/toolSearch.js'
import { getAnthropicClient } from './api/client.js'
import { isSpentUsageWindowAnswer, providerAskedWaitMs, providerWaitIsWindow, retrySeconds } from './api/recoveryBudget.js'
import { APIConnectionTimeoutError } from './api/sdkErrors.js'
import { is529Error, isRetryableError } from './api/withRetry.js'
import { busyRetryScale, nextBusyRetryWithinBudget, openBusyRetryLadder } from './providers/busyRetry.js'
import { declaredRouteOf } from './providers/routeLaw.js'
import { withTokenCountVCR } from './vcr.js'


const THINKING_BUDGET_TOKENS = 1024
const PLACEHOLDER_MESSAGES = [{ role: 'user' as const, content: 'hi' }]
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
            messages: body as never,
            tools: tools as never,
            ...(carried !== undefined ? { system: carried as never } : {}),
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
  const { model, effort } = countProbeCall()
  const response = await countWithBusyRetry(`${COUNT_SOURCE} (create probe)`, () =>
    sideQuery({
      model,
      messages: body as never,
      max_tokens: thinking ? 2048 : 1,
      ...(Array.isArray(tools) && tools.length > 0 ? { tools } : {}),
      thinking: thinking ? THINKING_BUDGET_TOKENS : false,
      ...(effort !== undefined ? { effort } : {}),
      maxRetries: 0,
      querySource: COUNT_SOURCE,
      source: COUNT_SOURCE,
    }),
  )
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
const PDF_PAGE_TOKENS = 3_500
const PDF_FALLBACK_BYTES_PER_PAGE = 150_000
const PDF_FALLBACK_PAGE_CAP = 20
const PDF_PAGE_COUNT_MEMO_LIMIT = 64
const NON_ASCII_RE = /[^\x00-\x7f]/
const NON_ASCII_ALL_RE = /[^\x00-\x7f]/g

function textTokenWeight(text: string): number {
  const base = text.length / DEFAULT_BYTES_PER_TOKEN
  if (!NON_ASCII_RE.test(text)) return base
  const wide = text.match(NON_ASCII_ALL_RE)?.length ?? 0
  return base + wide * (1 - 1 / DEFAULT_BYTES_PER_TOKEN)
}

const pdfPageCountMemo = new Map<string, number>()

function pdfPageObjects(text: string): number {
  return text.match(/\/Type\s*\/Page\b/g)?.length ?? 0
}

function pdfPageCountOf(bytes: Buffer): number | null {
  const text = bytes.toString('latin1')
  const linearized = /\/Linearized\b[\s\S]{0,300}?\/N\s+(\d+)/.exec(text)
  if (linearized !== null) return Number(linearized[1])
  let pages = pdfPageObjects(text)
  const objectStreams = /\/Type\s*\/ObjStm[\s\S]{0,400}?stream\r?\n/g
  for (let match = objectStreams.exec(text); match !== null; match = objectStreams.exec(text)) {
    const start = match.index + match[0].length
    const end = text.indexOf('endstream', start)
    if (end < 0) break
    try {
      pages += pdfPageObjects(inflateSync(bytes.subarray(start, end)).toString('latin1'))
    } catch {
    }
  }
  return pages > 0 ? pages : null
}

function pdfDocumentTokenWeight(source: unknown): number {
  const record = source as { type?: unknown; data?: unknown } | null
  if (record?.type !== 'base64' || typeof record.data !== 'string') return MEDIA_BLOCK_TOKENS
  const data = record.data
  const key = `${data.length}:${data.slice(0, 96)}:${data.slice(-96)}`
  let pages = pdfPageCountMemo.get(key)
  if (pages === undefined) {
    const bytes = Buffer.from(data, 'base64')
    pages = pdfPageCountOf(bytes) ?? Math.max(1, Math.min(PDF_FALLBACK_PAGE_CAP, Math.round(bytes.length / PDF_FALLBACK_BYTES_PER_PAGE)))
    if (pdfPageCountMemo.size >= PDF_PAGE_COUNT_MEMO_LIMIT) pdfPageCountMemo.delete(pdfPageCountMemo.keys().next().value as string)
    pdfPageCountMemo.set(key, pages)
  }
  return pages * PDF_PAGE_TOKENS
}

export function roughTokenCountEstimation(content: string, bytesPerToken?: number): number {
  return Math.round(content.length / (bytesPerToken ?? DEFAULT_BYTES_PER_TOKEN))
}

export function bytesPerTokenForFileType(ext: string): number {
  return ext === 'json' || ext === 'jsonl' || ext === 'jsonc' ? 2 : DEFAULT_BYTES_PER_TOKEN
}

export function roughTokenCountEstimationForFileType(content: string, ext: string): number {
  return roughTokenCountEstimation(content, bytesPerTokenForFileType(ext))
}

function contentTokenWeight(content: unknown, model?: string): number {
  if (typeof content === 'string') return textTokenWeight(content)
  if (Array.isArray(content)) return content.reduce((sum, part) => sum + contentTokenWeight(part, model), 0)
  if (typeof content !== 'object' || content === null) return 0
  const record = content as LooseBlock
  switch (record.type) {
    case 'text':
    case 'input_text':
    case 'output_text':
      return contentTokenWeight(String(record.text ?? ''), model)
    case 'image':
      return modelReceivesImageBlocks(model ?? getEngineModel()) ? MEDIA_BLOCK_TOKENS : contentTokenWeight('[image]', model)
    case 'image_url':
    case 'input_image':
      return MEDIA_BLOCK_TOKENS
    case 'document':
      return pdfDocumentTokenWeight(record.source)
    case 'tool_result':
      return contentTokenWeight(record.content, model)
    case 'tool_use':
      return contentTokenWeight(`${String(record.name ?? '')}${jsonStringify(record.input ?? {})}`, model)
    case 'thinking':
      return contentTokenWeight(String(record.thinking ?? ''), model)
    case 'redacted_thinking':
      return contentTokenWeight(String(record.data ?? ''), model)
    case 'function_call':
      return contentTokenWeight(`${String(record.name ?? '')}${String(record.arguments ?? '')}`, model)
    case 'function_call_output':
      return contentTokenWeight(record.output, model)
    default:
      if (typeof record.role === 'string') {
        const calls = Array.isArray(record.tool_calls) ? record.tool_calls as Array<{ function?: { name?: string; arguments?: string } }> : []
        return contentTokenWeight(record.content, model) + contentTokenWeight(record.reasoning_content, model) + calls.reduce((sum, call) => sum + contentTokenWeight(`${call.function?.name ?? ''}${call.function?.arguments ?? ''}`, model), 0)
      }
      return contentTokenWeight(jsonStringify(record) ?? '', model)
  }
}

export function estimateContentTokens(content: unknown, model?: string): number {
  return Math.ceil(contentTokenWeight(content, model))
}

function messageTokenWeight(message: Message, model?: string): number {
  if (message.type === 'assistant' || message.type === 'user') return contentTokenWeight(message.message.content, model)
  if (message.type === 'attachment') {
    const normalized = normalizeAttachmentForAPI(message.attachment as never)
    return normalized.reduce((sum, entry) => sum + messageTokenWeight(entry as Message, model), 0)
  }
  if (message.type === 'system') return contentTokenWeight('content' in message ? message.content : '', model)
  return 0
}

export function roughTokenCountEstimationForMessages(messages: readonly Message[], model?: string): number {
  return Math.ceil(messages.reduce((sum, message) => sum + messageTokenWeight(message, model), 0))
}

export function estimateRequestTokens(body: unknown, model?: string): number {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return estimateContentTokens(body, model)
  const request = body as { model?: unknown; messages?: unknown[]; input?: unknown; system?: unknown; instructions?: unknown; tools?: unknown[] }
  model ??= typeof request.model === 'string' ? request.model : undefined
  const rows = request.messages ?? request.input
  if (!Array.isArray(rows)) return estimateContentTokens(body, model)
  let total = contentTokenWeight(request.system, model) + contentTokenWeight(request.instructions, model)
  for (const row of rows) {
    total += row && typeof row === 'object' && 'type' in row && ['user', 'assistant', 'attachment', 'system'].includes(String(row.type))
      ? messageTokenWeight(row as Message, model)
      : contentTokenWeight(row, model)
  }
  if (request.tools?.length) total += (JSON.stringify(request.tools).length / (model !== undefined && declaredRouteOf(model) === 'local' ? 3.9 : DEFAULT_BYTES_PER_TOKEN))
  return Math.ceil(total)
}
