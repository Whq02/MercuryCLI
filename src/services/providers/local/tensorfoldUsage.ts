import type { CompatRuntimeReading, CompatUsage } from '../openaicompat/compatChatClient.js'
import { tensorFoldHostAddress } from './tensorfoldHosts.js'

export interface TensorFoldTurnReading {
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

export function tensorFoldTurnLine(turn: TensorFoldTurnReading): string {
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

export function __resetTensorFoldUsageForTest(): void {
  turns = []
}
