import type { Entry } from '../../types/logs.js'
import { servedModelOfAssistantRow } from '../model/retainedModel.js'
import { calculateUSDCost, modelPricingBasis } from '../modelCost.js'
import { listAgentTranscriptPaths } from './paths.js'
import { scanTranscriptEntriesForward } from './transcriptReader.js'

export type RolledModelUsage = {
  inputTokens: number
  outputTokens: number
  cacheReadInputTokens: number
  cacheCreationInputTokens: number
  webSearchRequests: number
  costUSD: number
}

export type TranscriptUsageRollup = {
  modelUsage: { [modelName: string]: RolledModelUsage }
  unpricedTurns: { [modelName: string]: number }
  totalCostUSD: number
  responses: number
  files: number
}

type CountedUsage = {
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens: number
  cache_creation_input_tokens: number
  server_tool_use?: { web_search_requests: number }
  cache_creation?: { ephemeral_1h_input_tokens: number }
}

type CountedRow = { seq: number; key: string; model: string; usage: CountedUsage }

function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0
}

function countedUsageOf(raw: unknown): CountedUsage | null {
  if (raw === null || typeof raw !== 'object') return null
  const u = raw as Record<string, unknown>
  const searches = count((u.server_tool_use as Record<string, unknown> | null | undefined)?.web_search_requests)
  const oneHour = count((u.cache_creation as Record<string, unknown> | null | undefined)?.ephemeral_1h_input_tokens)
  const usage: CountedUsage = {
    input_tokens: count(u.input_tokens),
    output_tokens: count(u.output_tokens),
    cache_read_input_tokens: count(u.cache_read_input_tokens),
    cache_creation_input_tokens: count(u.cache_creation_input_tokens),
    ...(searches > 0 ? { server_tool_use: { web_search_requests: searches } } : {}),
    ...(oneHour > 0 ? { cache_creation: { ephemeral_1h_input_tokens: oneHour } } : {}),
  }
  const spent = usage.input_tokens + usage.output_tokens + usage.cache_read_input_tokens + usage.cache_creation_input_tokens + searches
  return spent > 0 ? usage : null
}

function countedRowOf(entry: Entry, seq: number): CountedRow | null {
  if (entry.type !== 'assistant') return null
  const model = servedModelOfAssistantRow(entry)
  if (model === undefined) return null
  const message = entry.message as { id?: unknown; usage?: unknown }
  const usage = countedUsageOf(message.usage)
  if (usage === null) return null
  const id = message.id
  return { seq, key: typeof id === 'string' && id !== '' ? id : entry.uuid, model, usage }
}

function foldResponse(rollup: TranscriptUsageRollup, row: CountedRow): void {
  const cost = calculateUSDCost(row.model, row.usage)
  const record = rollup.modelUsage[row.model] ?? {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
    webSearchRequests: 0,
    costUSD: 0,
  }
  record.inputTokens += row.usage.input_tokens
  record.outputTokens += row.usage.output_tokens
  record.cacheReadInputTokens += row.usage.cache_read_input_tokens
  record.cacheCreationInputTokens += row.usage.cache_creation_input_tokens
  record.webSearchRequests += row.usage.server_tool_use?.web_search_requests ?? 0
  record.costUSD += cost
  rollup.modelUsage[row.model] = record
  rollup.totalCostUSD += cost
  rollup.responses += 1
  if (modelPricingBasis(row.model) === 'unpriced') {
    rollup.unpricedTurns[row.model] = (rollup.unpricedTurns[row.model] ?? 0) + 1
  }
}

export function rollupTranscriptUsage(rollup: TranscriptUsageRollup, path: string): boolean {
  const byUuid = new Map<string, CountedRow>()
  let seq = 0
  const read = scanTranscriptEntriesForward(path, entry => {
    seq += 1
    if (entry.type !== 'assistant') return
    const row = countedRowOf(entry, seq)
    if (row === null) byUuid.delete(entry.uuid)
    else byUuid.set(entry.uuid, row)
  })
  if (read.kind === 'none') return false
  rollup.files += 1
  const byResponse = new Map<string, CountedRow>()
  for (const row of byUuid.values()) {
    const prior = byResponse.get(row.key)
    if (prior === undefined || prior.seq < row.seq) byResponse.set(row.key, row)
  }
  for (const row of [...byResponse.values()].sort((a, b) => a.seq - b.seq)) foldResponse(rollup, row)
  return true
}

export function emptyUsageRollup(): TranscriptUsageRollup {
  return { modelUsage: {}, unpricedTurns: {}, totalCostUSD: 0, responses: 0, files: 0 }
}

export async function rollupSessionUsage(transcriptPath: string, sessionId: string): Promise<TranscriptUsageRollup> {
  const rollup = emptyUsageRollup()
  rollupTranscriptUsage(rollup, transcriptPath)
  for (const agentPath of await listAgentTranscriptPaths(transcriptPath, sessionId)) {
    rollupTranscriptUsage(rollup, agentPath)
  }
  return rollup
}
