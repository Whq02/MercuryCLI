import { gibWords, tokensWords } from '../../localServer/localServerMemory.js'
import type { TensorFoldHost, TensorFoldServed } from '../../tensorfold/contracts.js'
import type { CompatRuntimeReading, CompatUsage } from '../openaicompat/compatChatClient.js'
import { localWireId } from './localCatalogue.js'
import { getCachedLocalDiscovery, type LocalDiscoverySnapshot } from './localDiscovery.js'
import { tensorFoldHostAddress, tensorFoldHosts } from './tensorfoldHosts.js'

interface TensorFoldTurnReading {
  at: number
  model: string
  address: string
  promptTokens: number
  completionTokens: number
  cachedTokens?: number
  reasoningTokens?: number
  tokensPerSecond?: number
  decodeSeconds?: number
  timeToFirstTokenS?: number
  prefillSeconds?: number
  reasoningEffort?: string
  thinking?: boolean
  draftAcceptance?: number
}

const KEPT_TURNS = 50
let turns: TensorFoldTurnReading[] = []

export function noteTensorFoldTurn(reading: { model: string; baseUrl: string; usage: CompatUsage | undefined; runtime: CompatRuntimeReading | undefined; at?: number }): TensorFoldTurnReading | undefined {
  if (reading.usage === undefined && reading.runtime === undefined) return undefined
  const row: TensorFoldTurnReading = {
    at: reading.at ?? Date.now(),
    model: reading.model,
    address: tensorFoldHostAddress(reading.baseUrl),
    promptTokens: reading.usage?.inputTokens ?? 0,
    completionTokens: reading.usage?.outputTokens ?? 0,
    ...(reading.usage?.cachedInputTokens !== undefined ? { cachedTokens: reading.usage.cachedInputTokens } : {}),
    ...(reading.usage?.reasoningTokens !== undefined ? { reasoningTokens: reading.usage.reasoningTokens } : {}),
    ...(reading.runtime?.tokensPerSecond !== undefined ? { tokensPerSecond: reading.runtime.tokensPerSecond } : {}),
    ...(reading.runtime?.decodeSeconds !== undefined ? { decodeSeconds: reading.runtime.decodeSeconds } : {}),
    ...(reading.runtime?.timeToFirstTokenS !== undefined ? { timeToFirstTokenS: reading.runtime.timeToFirstTokenS } : {}),
    ...(reading.runtime?.prefillSeconds !== undefined ? { prefillSeconds: reading.runtime.prefillSeconds } : {}),
    ...(reading.runtime?.reasoningEffort !== undefined ? { reasoningEffort: reading.runtime.reasoningEffort } : {}),
    ...(reading.runtime?.thinking !== undefined ? { thinking: reading.runtime.thinking } : {}),
    ...(reading.runtime?.draftAcceptance !== undefined ? { draftAcceptance: reading.runtime.draftAcceptance } : {}),
  }
  turns = [...turns.slice(-(KEPT_TURNS - 1)), row]
  return row
}

export function tensorFoldTurnReadings(): readonly TensorFoldTurnReading[] {
  return turns
}

export function lastTensorFoldTurn(): TensorFoldTurnReading | undefined {
  return turns.at(-1)
}

function secondsWords(seconds: number): string {
  return seconds < 1 ? `${Math.round(seconds * 1000)} ms` : `${seconds.toFixed(1)} s`
}

function tensorFoldTurnLine(turn: TensorFoldTurnReading): string {
  const parts = [turn.model]
  if (turn.tokensPerSecond !== undefined) parts.push(`~${Math.round(turn.tokensPerSecond)} tok/s`)
  if (turn.timeToFirstTokenS !== undefined) parts.push(`first token in ${secondsWords(turn.timeToFirstTokenS)}`)
  if (turn.prefillSeconds !== undefined) parts.push(`prefill ${secondsWords(turn.prefillSeconds)}`)
  parts.push(`${turn.promptTokens.toLocaleString()} in${turn.cachedTokens !== undefined ? ` (${turn.cachedTokens.toLocaleString()} cached)` : ''}`)
  parts.push(`${turn.completionTokens.toLocaleString()} out${turn.reasoningTokens !== undefined && turn.reasoningTokens > 0 ? ` (${turn.reasoningTokens.toLocaleString()} thinking)` : ''}`)
  if (turn.reasoningEffort !== undefined) parts.push(`effort ${turn.reasoningEffort}`)
  if (turn.draftAcceptance !== undefined) parts.push(`drafts ${Math.round(turn.draftAcceptance * 100)}% accepted`)
  return parts.join(' · ')
}

export function tensorFoldUsageLines(readings: readonly TensorFoldTurnReading[] = turns): string[] {
  if (readings.length === 0) return []
  const last = readings.at(-1)!
  const lines = [`last turn · ${tensorFoldTurnLine(last)}`]
  if (readings.length > 1) {
    const timed = readings.filter(turn => turn.decodeSeconds !== undefined && turn.decodeSeconds > 0 && turn.completionTokens > 1)
    const decodeSeconds = timed.reduce((sum, turn) => sum + turn.decodeSeconds!, 0)
    const decoded = timed.reduce((sum, turn) => sum + turn.completionTokens - 1, 0)
    const prompt = readings.reduce((sum, turn) => sum + turn.promptTokens, 0)
    const cached = readings.reduce((sum, turn) => sum + (turn.cachedTokens ?? 0), 0)
    const completion = readings.reduce((sum, turn) => sum + turn.completionTokens, 0)
    const parts = [`${readings.length} turns`]
    if (decodeSeconds > 0) parts.push(`~${Math.round(decoded / decodeSeconds)} tok/s on average`)
    parts.push(`${prompt.toLocaleString()} in (${cached.toLocaleString()} cached${prompt > 0 ? ` · ${Math.round((cached / prompt) * 100)}%` : ''})`)
    parts.push(`${completion.toLocaleString()} out`)
    lines.push(`this session · ${parts.join(' · ')}`)
  }
  return lines
}

export type TensorFoldServingState = 'serving' | 'draining' | 'loading' | 'absent'

export interface TensorFoldServing {
  model: string
  state: TensorFoldServingState
  address?: string
  window?: number
  inUseBytes?: number
}

export interface TensorFoldServingReads {
  snapshot?: () => LocalDiscoverySnapshot | null
  served?: () => readonly TensorFoldServed[]
  hosts?: () => readonly TensorFoldHost[]
  turns?: () => readonly TensorFoldTurnReading[]
}

function readServed(): readonly TensorFoldServed[] {
  try {
    const { servedTensorFold } = require('../../tensorfold/serve.js') as typeof import('../../tensorfold/serve.js')
    return servedTensorFold()
  } catch {
    return []
  }
}

function readHosts(): readonly TensorFoldHost[] {
  try {
    return tensorFoldHosts()
  } catch {
    return []
  }
}

function sameModel(served: string, name: string): boolean {
  const lower = served.toLowerCase()
  return lower === name || lower.endsWith(`/${name}`)
}

export function tensorFoldServing(model: string, reads: TensorFoldServingReads = {}): TensorFoldServing | undefined {
  const wire = localWireId(model)
  const name = wire.toLowerCase()
  if (name === '') return undefined
  for (const server of (reads.snapshot ?? getCachedLocalDiscovery)()?.servers ?? []) {
    if (server.kind !== 'tensorfold') continue
    const listed = server.models.find(candidate => sameModel(candidate.id, name))
    if (listed === undefined) continue
    const inUseBytes = server.engine?.inUseBytes ?? listed.servedBytes
    return {
      model: listed.id,
      state: server.engine?.draining ? 'draining' : 'serving',
      address: tensorFoldHostAddress(server.root),
      ...(listed.contextWindow !== undefined ? { window: listed.contextWindow.tokens } : {}),
      ...(inUseBytes !== undefined ? { inUseBytes } : {}),
    }
  }
  const started = (reads.served ?? readServed)().find(row => sameModel(row.name, name) || sameModel(row.repo, name))
  if (started !== undefined) return { model: started.name, state: 'loading', address: `127.0.0.1:${started.port}`, window: started.window }
  const host = (reads.hosts ?? readHosts)().find(row => row.serving !== undefined && sameModel(row.serving, name))
  const turn = (reads.turns ?? tensorFoldTurnReadings)().findLast(row => sameModel(row.model, name))
  if (host === undefined && turn === undefined && !model.trim().toLowerCase().startsWith('local/tensorfold/')) return undefined
  return { model: host?.serving ?? turn?.model ?? wire, state: 'absent', ...(host !== undefined ? { address: tensorFoldHostAddress(host.baseUrl) } : turn !== undefined ? { address: turn.address } : {}) }
}

export const TENSORFOLD_USAGE_SLOT = 'TensorFold'

export function tensorFoldServingLine(serving: TensorFoldServing, readings: readonly TensorFoldTurnReading[] = turns): string {
  if (serving.state === 'absent') return `${serving.model} is not served · /tensorfold serves it`
  const parts = [`${serving.state} ${serving.model}${serving.address !== undefined ? ` on ${serving.address}` : ''}`]
  if (serving.window !== undefined) parts.push(`${tokensWords(serving.window)} ctx`)
  if (serving.inUseBytes !== undefined) parts.push(`${gibWords(serving.inUseBytes)} in use`)
  const answered = readings.some(turn => sameModel(turn.model, serving.model.toLowerCase()) && (serving.address === undefined || turn.address === serving.address))
  if (serving.state !== 'loading' && !answered) parts.push('idle')
  return parts.join(' · ')
}

export function __resetTensorFoldUsageForTest(): void {
  turns = []
}
