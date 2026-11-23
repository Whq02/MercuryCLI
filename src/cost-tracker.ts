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
import type { ApiUsage } from './types/wire.js'
import { usageCount } from './utils/api/emptyUsage.js'
import { formatCost, formatSessionCost, formatLaneSpend } from './services/providers/spendSpelling.js'
export { formatCost, formatSessionCost, formatLaneSpend }
import { getCurrentProjectConfig, saveCurrentProjectConfig } from './utils/config.js'
import { logForDebugging } from './utils/debug.js'
import { formatDuration, formatNumber } from './utils/format.js'
import { getTranscriptPathForSession } from './utils/sessionStorage/paths.js'
import type { TranscriptUsageRollup } from './services/usage/usageRollup.js'
import type { FpsMetrics } from './utils/fpsTracker.js'
import { modelPricingBasis } from './services/usage/modelCost.js'
import { parseFirstPartyGeneration } from './utils/model/configs.js'
import { getCanonicalName } from './services/model/model.js'
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
  unpricedTurns?: { [modelName: string]: number } | undefined
  workloadUsage?: WorkloadUsage | undefined
  workloadUnpricedTurns?: WorkloadUnpricedTurns | undefined
}

export type LedgerCostBasis = {
  basis: 'wire-stated'
}

export function addToTotalSessionCost(
  cost: number,
  usage: NonNullableUsage | ApiUsage,
  model: string,
  pricing?: LedgerCostBasis,
): number {
  const costInvalid =
    !Number.isFinite(cost) || cost < 0 || !Number.isFinite(getTotalCostUSD() + cost)
  const recordedCost = costInvalid ? 0 : cost

  const inputTokens = usageCount(usage.input_tokens)
  const outputTokens = usageCount(usage.output_tokens)
  const cacheReadInputTokens = usageCount(usage.cache_read_input_tokens)
  const cacheCreationInputTokens = usageCount(usage.cache_creation_input_tokens)
  const webSearchRequests = usageCount(usage.server_tool_use?.web_search_requests)
  void usageCount(usage.server_tool_use?.web_fetch_requests)

  const existing = getUsageForModel(model) ?? {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
    webSearchRequests: 0,
    costUSD: 0,
  }
  const updated: ModelUsage = {
    ...existing,
    inputTokens: existing.inputTokens + inputTokens,
    outputTokens: existing.outputTokens + outputTokens,
    cacheReadInputTokens: existing.cacheReadInputTokens + cacheReadInputTokens,
    cacheCreationInputTokens: existing.cacheCreationInputTokens + cacheCreationInputTokens,
    webSearchRequests: existing.webSearchRequests + webSearchRequests,
    costUSD: existing.costUSD + recordedCost,
    contextWindow: getContextWindowForModel(model, getSdkBetas()),
    maxOutputTokens: getModelMaxOutputTokens(model).default,
    lastUsedAtMs: Date.now(),
  }
  addToTotalCostState(recordedCost, updated, model)

  const workload = getWorkload()
  if (
    costInvalid ||
    (pricing?.basis !== 'wire-stated' && modelPricingBasis(model) === 'unpriced')
  ) {
    recordUnpricedTurn(model)
    if (workload !== undefined) {
      recordWorkloadUnpricedTurn(workload, model)
    }
  }

  if (workload !== undefined) {
    addToWorkloadUsageState(
      workload,
      {
        inputTokens,
        outputTokens,
        cacheReadInputTokens,
        cacheCreationInputTokens,
        webSearchRequests,
        costUSD: recordedCost,
      },
      model,
    )
  }

  recordUsagePulse(recordedCost)
  return recordedCost
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

function stripUsageFields(usage: ModelUsage): {
  inputTokens: number
  outputTokens: number
  cacheReadInputTokens: number
  cacheCreationInputTokens: number
  webSearchRequests: number
  costUSD: number
} {
  return {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cacheReadInputTokens: usage.cacheReadInputTokens,
    cacheCreationInputTokens: usage.cacheCreationInputTokens,
    webSearchRequests: usage.webSearchRequests,
    costUSD: usage.costUSD,
  }
}

export function saveCurrentSessionCosts(fpsMetrics?: FpsMetrics): void {
  if (!sessionSawUsage()) return
  let sessionId: string | undefined
  try {
    sessionId = getSessionId()
  } catch {
    sessionId = undefined
  }
  saveCurrentProjectConfig(current => ({
    ...current,
    lastCostWindow: {
      kind: 'session-cumulative',
      ...(sessionId ? { sessionId } : {}),
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
    ...(fpsMetrics !== undefined
      ? {
          lastFpsAverage: fpsMetrics.averageFps,
          lastFpsLow1Pct: fpsMetrics.low1PctFps,
        }
      : {}),
    lastSessionId: sessionId,
    lastModelUsage: mapValues(getModelUsage(), stripUsageFields),
    lastUnpricedTurns: { ...getUnpricedTurns() },
    lastWorkloadUsage: mapValues(
      getWorkloadUsage() as Record<string, Record<string, ModelUsage>>,
      bucket => mapValues(bucket, stripUsageFields),
    ),
    lastWorkloadUnpricedTurns: mapValues(
      getWorkloadUnpricedTurns() as Record<string, Record<string, number>>,
      bucket => ({ ...bucket }),
    ),
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
      ? mapValues(config.lastWorkloadUsage, bucket =>
          mapValues(bucket, usage => ({ ...usage })),
        )
      : undefined,
    workloadUnpricedTurns: config.lastWorkloadUnpricedTurns
      ? mapValues(config.lastWorkloadUnpricedTurns, bucket => ({ ...bucket }))
      : undefined,
  }
}

function withDerivedLimits(usage: {
  [modelName: string]: Omit<ModelUsage, 'contextWindow' | 'maxOutputTokens'>
}): { [modelName: string]: ModelUsage } {
  const betas = getSdkBetas()
  return mapValues(usage, (record, modelName) => ({
    ...record,
    contextWindow: getContextWindowForModel(modelName, betas),
    maxOutputTokens: getModelMaxOutputTokens(modelName).default,
  }))
}

async function transcriptLedgerForSession(
  sessionId: string,
  transcriptPath: string | undefined,
): Promise<TranscriptUsageRollup | null> {
  try {
    const { rollupSessionUsage } = await import('./services/usage/usageRollup.js')
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

function usageRowName(model: string): string {
  const canonical = getCanonicalName(model)
  const parsed = parseFirstPartyGeneration(model)
  return parsed !== null && parsed.stem === canonical ? parsed.spelled : canonical
}

export function formatTotalCost(): string {
  const unknownNote = hasUnknownModelCost()
    ? ' (costs may be inaccurate due to usage of unknown models)'
    : ''
  const lines: string[] = [
    labelled('Total cost:', `${formatSessionCost(getTotalCostUSD(), getTotalUnpricedTurns())}${unknownNote}`),
    labelled('Total duration (API):', formatDuration(getTotalAPIDuration())),
    labelled('Total duration (wall):', formatDuration(getTotalDuration())),
    labelled(
      'Total code changes:',
      `${pluralizeLines(getTotalLinesAdded())} added, ${pluralizeLines(getTotalLinesRemoved())} removed`,
    ),
  ]

  const modelUsage = getModelUsage()
  const modelEntries = Object.entries(modelUsage)
  if (modelEntries.length === 0) {
    lines.push(labelled('Tokens spent:', '0 input, 0 output, 0 cache read, 0 cache write'))
  } else {
    const unpricedTurns = getUnpricedTurns()
    const grouped = new Map<
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
    for (const [model, usage] of modelEntries) {
      const name = usageRowName(model)
      const current = grouped.get(name) ?? {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
        webSearchRequests: 0,
        costUSD: 0,
        unpricedTurns: 0,
      }
      current.inputTokens += usage.inputTokens
      current.outputTokens += usage.outputTokens
      current.cacheReadInputTokens += usage.cacheReadInputTokens
      current.cacheCreationInputTokens += usage.cacheCreationInputTokens
      current.webSearchRequests += usage.webSearchRequests
      current.costUSD += usage.costUSD
      current.unpricedTurns += unpricedTurns[model] ?? 0
      grouped.set(name, current)
    }

    lines.push('Tokens spent by model:')
    for (const [name, group] of grouped) {
      const nameColumn = `${name}:`.padStart(MODEL_NAME_COLUMN)
      const counts = [
        `${formatNumber(group.inputTokens)} input`,
        `${formatNumber(group.outputTokens)} output`,
        `${formatNumber(group.cacheReadInputTokens)} cache read`,
        `${formatNumber(group.cacheCreationInputTokens)} cache write`,
        ...(group.webSearchRequests > 0
          ? [`${formatNumber(group.webSearchRequests)} web search`]
          : []),
      ].join(', ')
      const costText = formatSessionCost(group.costUSD, group.unpricedTurns)
      lines.push(`${nameColumn}  ${counts} (${costText})`)
    }
  }

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
export { readUsageHistory, type UsageHistoryReport, type UsageTotals } from './services/usage/usageHistory.js'
