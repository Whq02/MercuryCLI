import { getModelUsage, getTotalAPIDuration, getTotalCostUSD, getUnpricedTurns } from '../../../boot/process-state/processState.js'
import type { ModelUsage } from '../../../boot/process-state/processState.js'

export type LedgerMark = {
  costUSD: number
  apiDuration: number
  modelUsage: { [modelName: string]: ModelUsage }
  unpricedTurns: { [modelName: string]: number }
}

const LEDGER_COUNTERS = ['inputTokens', 'outputTokens', 'cacheReadInputTokens', 'cacheCreationInputTokens', 'webSearchRequests', 'costUSD'] as const

export function usageSince(current: Record<string, ModelUsage>, baseline: Record<string, ModelUsage>): Record<string, ModelUsage> {
  const result: Record<string, ModelUsage> = {}
  for (const [model, row] of Object.entries(current)) {
    const delta = { ...row }
    for (const counter of LEDGER_COUNTERS) {
      delta[counter] = Math.max(0, row[counter] - (baseline[model]?.[counter] ?? 0))
    }
    if (LEDGER_COUNTERS.some(counter => delta[counter] > 0)) result[model] = delta
  }
  return result
}

export function ledgerMark(): LedgerMark {
  return {
    costUSD: getTotalCostUSD(),
    apiDuration: getTotalAPIDuration(),
    modelUsage: Object.fromEntries(Object.entries(getModelUsage()).map(([model, row]) => [model, { ...row }])),
    unpricedTurns: { ...getUnpricedTurns() },
  }
}

export function ledgerSpentSince(mark: LedgerMark): LedgerMark {
  const unpricedTurns: { [modelName: string]: number } = {}
  for (const [model, turns] of Object.entries(getUnpricedTurns())) {
    if (turns > (mark.unpricedTurns[model] ?? 0)) unpricedTurns[model] = turns - (mark.unpricedTurns[model] ?? 0)
  }
  return {
    costUSD: Math.max(0, getTotalCostUSD() - mark.costUSD),
    apiDuration: Math.max(0, getTotalAPIDuration() - mark.apiDuration),
    modelUsage: usageSince(getModelUsage(), mark.modelUsage),
    unpricedTurns,
  }
}

export function advanceLedgerMark(mark: LedgerMark, spent: LedgerMark): void {
  mark.costUSD += spent.costUSD
  mark.apiDuration += spent.apiDuration
  for (const [model, row] of Object.entries(spent.modelUsage)) {
    const held = (mark.modelUsage[model] ??= { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, webSearchRequests: 0, costUSD: 0 })
    for (const counter of LEDGER_COUNTERS) held[counter] += row[counter]
  }
  for (const [model, turns] of Object.entries(spent.unpricedTurns)) mark.unpricedTurns[model] = (mark.unpricedTurns[model] ?? 0) + turns
}
