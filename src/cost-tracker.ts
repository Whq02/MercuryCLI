import chalk from 'chalk'
import { mapValues } from 'lodash-es'
import {
  addToTotalCostState,
  addToWorkloadUsageState,
  getModelUsage,
  getSdkBetas,
  getSessionId,
  getTotalAPIDuration,
  getTotalAPIDurationWithoutRetries,
  getTotalCostUSD,
  getTotalDuration,
  getTotalLinesAdded,
  getTotalLinesRemoved,
  getTotalToolDuration,
  getTotalUnpricedTurns,
  getUnpricedTurns,
  getUsageForModel,
  getWorkloadUnpricedTurns,
  getWorkloadUsage,
  hasUnknownModelCost,
  recordUnpricedTurn,
  recordWorkloadUnpricedTurn,
  setCostStateForRestore,
} from './bootstrap/state.js'
import type { ModelUsage, WorkloadUnpricedTurns, WorkloadUsage } from './bootstrap/state.js'
import { getWorkload } from './utils/workloadContext.js'
import type { NonNullableUsage } from './services/api/logging.js'
import type { ProviderSessionSpend } from './services/providers/providerUsage.js'
import { formatCost, formatSessionCost, formatLaneSpend } from './utils/spendSpelling.js'
export { formatCost, formatSessionCost, formatLaneSpend }
import { getCurrentProjectConfig, saveCurrentProjectConfig } from './utils/config.js'
import { logForDebugging } from './utils/debug.js'
import { formatDuration, formatNumber } from './utils/format.js'
import { getTranscriptPathForSession } from './utils/sessionStorage/paths.js'
import type { TranscriptUsageRollup } from './utils/sessionStorage/usageRollup.js'
import type { FpsMetrics } from './utils/fpsTracker.js'
import { modelPricingBasis } from './utils/modelCost.js'
import { getCanonicalName } from './utils/model/model.js'
import {
  getContextWindowForModel,
  getModelMaxOutputTokens,
} from './utils/model/capabilities.js'
import { recordUsagePulse } from './utils/cockpit/usageActivity.js'

const VALUE_COLUMN = 23
const MODEL_NAME_COLUMN = 21

type StoredCostState = {
  totalCostUSD: number
  totalAPIDuration: number
  totalAPIDurationWithoutRetries: number
  totalToolDuration: number
  totalLinesAdded: number
  totalLinesRemoved: number
  lastDuration: number | undefined
  modelUsage: { [modelName: string]: ModelUsage } | undefined
  unpricedTurns: { [modelName: string]: number } | undefined
  workloadUsage: WorkloadUsage | undefined
  workloadUnpricedTurns: WorkloadUnpricedTurns | undefined
}

export type LedgerCostBasis = { basis: 'wire-stated' }

export function addToTotalSessionCost(
  cost: number,
  usage: NonNullableUsage,
  model: string,
  pricing?: LedgerCostBasis,
): number {
  const record: ModelUsage = getUsageForModel(model) ?? {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
    webSearchRequests: 0,
    costUSD: 0,
    contextWindow: 0,
    maxOutputTokens: 0,
  }
  record.inputTokens += usage.input_tokens
  record.outputTokens += usage.output_tokens
  record.cacheReadInputTokens += usage.cache_read_input_tokens ?? 0
  record.cacheCreationInputTokens += usage.cache_creation_input_tokens ?? 0
  record.webSearchRequests += usage.server_tool_use?.web_search_requests ?? 0
  record.costUSD += cost
  record.contextWindow = getContextWindowForModel(model, getSdkBetas())
  record.maxOutputTokens = getModelMaxOutputTokens(model).default
  addToTotalCostState(cost, record, model)
  const workload = getWorkload()
  if (pricing?.basis !== 'wire-stated' && modelPricingBasis(model) === 'unpriced') {
    recordUnpricedTurn(model)
    if (workload !== undefined) recordWorkloadUnpricedTurn(workload, model)
  }
  if (workload !== undefined) {
    addToWorkloadUsageState(
      workload,
      {
        inputTokens: usage.input_tokens,
        outputTokens: usage.output_tokens,
        cacheReadInputTokens: usage.cache_read_input_tokens ?? 0,
        cacheCreationInputTokens: usage.cache_creation_input_tokens ?? 0,
        webSearchRequests: usage.server_tool_use?.web_search_requests ?? 0,
        costUSD: cost,
      },
      model,
    )
  }
  recordUsagePulse(cost)

  return cost
}

export function sessionSawUsage(): boolean {
  return (
    getTotalCostUSD() > 0 ||
    getTotalAPIDuration() > 0 ||
    getTotalInputTokens() > 0 ||
    getTotalOutputTokens() > 0 ||
    Object.keys(getModelUsage()).length > 0
  )
}

export function saveCurrentSessionCosts(fpsMetrics?: FpsMetrics): void {
  if (!sessionSawUsage()) return
  let windowSessionId: string | undefined
  try {
    windowSessionId = getSessionId()
  } catch {
    windowSessionId = undefined
  }
  saveCurrentProjectConfig(currentConfig => ({
    ...currentConfig,
    lastCostWindow: {
      kind: 'session-cumulative',
      ...(windowSessionId ? { sessionId: windowSessionId } : {}),
      savedAtMs: Date.now(),
    },
    lastCost: getTotalCostUSD(),
    lastAPIDuration: getTotalAPIDuration(),
    lastAPIDurationWithoutRetries: getTotalAPIDurationWithoutRetries(),
    lastToolDuration: getTotalToolDuration(),
    lastDuration: getTotalDuration(),
    lastLinesAdded: getTotalLinesAdded(),
    lastLinesRemoved: getTotalLinesRemoved(),
    lastTotalInputTokens: getTotalInputTokens(),
    lastTotalOutputTokens: getTotalOutputTokens(),
    lastTotalCacheCreationInputTokens: getTotalCacheCreationInputTokens(),
    lastTotalCacheReadInputTokens: getTotalCacheReadInputTokens(),
    lastTotalWebSearchRequests: getTotalWebSearchRequests(),
    lastFpsAverage: fpsMetrics?.averageFps,
    lastFpsLow1Pct: fpsMetrics?.low1PctFps,
    lastModelUsage: mapValues(getModelUsage(), usage => ({
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cacheReadInputTokens: usage.cacheReadInputTokens,
      cacheCreationInputTokens: usage.cacheCreationInputTokens,
      webSearchRequests: usage.webSearchRequests,
      costUSD: usage.costUSD,
    })),
    lastUnpricedTurns: { ...getUnpricedTurns() },
    lastWorkloadUsage: mapValues(getWorkloadUsage(), bucket =>
      mapValues(bucket, usage => ({
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        cacheReadInputTokens: usage.cacheReadInputTokens,
        cacheCreationInputTokens: usage.cacheCreationInputTokens,
        webSearchRequests: usage.webSearchRequests,
        costUSD: usage.costUSD,
      })),
    ),
    lastWorkloadUnpricedTurns: mapValues(getWorkloadUnpricedTurns(), bucket => ({ ...bucket })),
    lastSessionId: getSessionId(),
  }))
}

export function getStoredSessionCosts(
  sessionId: string,
): StoredCostState | undefined {
  const config = getCurrentProjectConfig()
  if (config.lastSessionId !== sessionId) {
    return undefined
  }
  return {
    totalCostUSD: config.lastCost ?? 0,
    totalAPIDuration: config.lastAPIDuration ?? 0,
    totalAPIDurationWithoutRetries: config.lastAPIDurationWithoutRetries ?? 0,
    totalToolDuration: config.lastToolDuration ?? 0,
    totalLinesAdded: config.lastLinesAdded ?? 0,
    totalLinesRemoved: config.lastLinesRemoved ?? 0,
    lastDuration: config.lastDuration,
    modelUsage: config.lastModelUsage ? withDerivedLimits(config.lastModelUsage) : undefined,
    unpricedTurns: config.lastUnpricedTurns ? { ...config.lastUnpricedTurns } : undefined,
    workloadUsage: config.lastWorkloadUsage
      ? mapValues(config.lastWorkloadUsage, bucket => mapValues(bucket, usage => ({ ...usage })))
      : undefined,
    workloadUnpricedTurns: config.lastWorkloadUnpricedTurns
      ? mapValues(config.lastWorkloadUnpricedTurns, bucket => ({ ...bucket }))
      : undefined,
  }
}

function withDerivedLimits(usage: {
  [modelName: string]: Omit<ModelUsage, 'contextWindow' | 'maxOutputTokens'>
}): { [modelName: string]: ModelUsage } {
  return mapValues(usage, (stored, model) => ({
    ...stored,
    contextWindow: getContextWindowForModel(model, getSdkBetas()),
    maxOutputTokens: getModelMaxOutputTokens(model).default,
  }))
}

async function transcriptLedgerForSession(
  sessionId: string,
  transcriptPath: string | undefined,
): Promise<TranscriptUsageRollup | null> {
  try {
    const { rollupSessionUsage } = await import('./utils/sessionStorage/usageRollup.js')
    const rollup = await rollupSessionUsage(transcriptPath ?? getTranscriptPathForSession(sessionId), sessionId)
    return rollup.responses > 0 ? rollup : null
  } catch (error) {
    logForDebugging(`cost restore: the transcript rollup for ${sessionId} failed: ${String(error)}`)
    return null
  }
}

export async function restoreCostStateForSession(
  sessionId: string,
  transcriptPath?: string,
): Promise<boolean> {
  const stored = getStoredSessionCosts(sessionId)
  const rebuilt = await transcriptLedgerForSession(sessionId, transcriptPath)
  if (rebuilt === null && stored === undefined) {
    return false
  }
  setCostStateForRestore({
    totalCostUSD: rebuilt?.totalCostUSD ?? stored?.totalCostUSD ?? 0,
    totalAPIDuration: stored?.totalAPIDuration ?? 0,
    totalAPIDurationWithoutRetries: stored?.totalAPIDurationWithoutRetries ?? 0,
    totalToolDuration: stored?.totalToolDuration ?? 0,
    totalLinesAdded: stored?.totalLinesAdded ?? 0,
    totalLinesRemoved: stored?.totalLinesRemoved ?? 0,
    lastDuration: stored?.lastDuration,
    modelUsage: rebuilt ? withDerivedLimits(rebuilt.modelUsage) : stored?.modelUsage,
    unpricedTurns: rebuilt ? { ...rebuilt.unpricedTurns } : stored?.unpricedTurns,
    workloadUsage: rebuilt ? mapValues(rebuilt.workloadUsage, bucket => mapValues(bucket, usage => ({ ...usage }))) : stored?.workloadUsage,
    workloadUnpricedTurns: rebuilt ? mapValues(rebuilt.workloadUnpricedTurns, bucket => ({ ...bucket })) : stored?.workloadUnpricedTurns,
  })
  return true
}


function labelled(label: string, value: string): string {
  return `${label.padEnd(VALUE_COLUMN)}${value}`
}

function pluralizeLines(count: number): string {
  return `${count} ${count === 1 ? 'line' : 'lines'}`
}

function formatModelUsageRows(): string[] {
  const byModel = getModelUsage()
  const models = Object.keys(byModel)
  if (models.length === 0) {
    return [labelled('Tokens spent:', '0 input, 0 output, 0 cache read, 0 cache write')]
  }
  const byShortName = new Map<
    string,
    {
      inputTokens: number
      outputTokens: number
      cacheReadInputTokens: number
      cacheCreationInputTokens: number
      webSearchRequests: number
      costUSD: number
      unpricedTurns: number
    }
  >()
  const unpriced = getUnpricedTurns()
  for (const model of models) {
    const usage = byModel[model]!
    const shortName = getCanonicalName(model)
    const row = byShortName.get(shortName) ?? {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      webSearchRequests: 0,
      costUSD: 0,
      unpricedTurns: 0,
    }
    row.inputTokens += usage.inputTokens
    row.outputTokens += usage.outputTokens
    row.cacheReadInputTokens += usage.cacheReadInputTokens
    row.cacheCreationInputTokens += usage.cacheCreationInputTokens
    row.webSearchRequests += usage.webSearchRequests
    row.costUSD += usage.costUSD
    row.unpricedTurns += unpriced[model] ?? 0
    byShortName.set(shortName, row)
  }
  const rows = ['Tokens spent by model:']
  for (const [shortName, row] of byShortName) {
    const metrics = [
      `${formatNumber(row.inputTokens)} input`,
      `${formatNumber(row.outputTokens)} output`,
      `${formatNumber(row.cacheReadInputTokens)} cache read`,
      `${formatNumber(row.cacheCreationInputTokens)} cache write`,
    ]
    if (row.webSearchRequests > 0) {
      metrics.push(`${formatNumber(row.webSearchRequests)} web search`)
    }
    rows.push(
      `${`${shortName}:`.padStart(MODEL_NAME_COLUMN)}  ${metrics.join(', ')} (${formatSessionCost(row.costUSD, row.unpricedTurns)})`,
    )
  }
  return rows
}

export function formatTotalCost(): string {
  const unknownCaveat = hasUnknownModelCost()
    ? ' (costs may be inaccurate due to usage of unknown models)'
    : ''
  const lines = [
    labelled('Total cost:', `${formatSessionCost(getTotalCostUSD(), getTotalUnpricedTurns())}${unknownCaveat}`),
    labelled('Total duration (API):', formatDuration(getTotalAPIDuration())),
    labelled('Total duration (wall):', formatDuration(getTotalDuration())),
    labelled(
      'Total code changes:',
      `${pluralizeLines(getTotalLinesAdded())} added, ${pluralizeLines(getTotalLinesRemoved())} removed`,
    ),
    ...formatModelUsageRows(),
  ]
  return chalk.dim(lines.join('\n'))
}

export {
  addToTotalLinesChanged,
  getModelUsage,
  getTotalAPIDuration,
  getTotalAPIDurationWithoutRetries,
  getTotalCacheCreationInputTokens,
  getTotalCacheReadInputTokens,
  getTotalCostUSD as getTotalCost,
  getTotalDuration,
  getTotalInputTokens,
  getTotalLinesAdded,
  getTotalLinesRemoved,
  getTotalOutputTokens,
  getTotalUnpricedTurns,
  getTotalWebSearchRequests,
  getUnpricedTurns,
  getUsageForModel,
  getWorkloadUnpricedTurns,
  getWorkloadUsage,
  hasUnknownModelCost,
  resetCostState,
  resetStateForTests,
  setHasUnknownModelCost,
} from './bootstrap/state.js'
import {
  getTotalCacheCreationInputTokens,
  getTotalCacheReadInputTokens,
  getTotalInputTokens,
  getTotalOutputTokens,
  getTotalWebSearchRequests,
} from './bootstrap/state.js'
