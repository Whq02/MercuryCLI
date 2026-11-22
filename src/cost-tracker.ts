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

type StoredCostState = Unbuilt

export type LedgerCostBasis = Unbuilt

export function addToTotalSessionCost(
  cost: number,
  usage: NonNullableUsage | ApiUsage,
  model: string,
  pricing?: LedgerCostBasis,
): number {
  return notBuilt('src/cost-tracker.ts:67')
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
  return notBuilt('src/cost-tracker.ts:130')
}

export function getStoredSessionCosts(
  sessionId: string,
): StoredCostState | undefined {
  return notBuilt('src/cost-tracker.ts:183')
}

function withDerivedLimits(usage: {
  [modelName: string]: Omit<ModelUsage, 'contextWindow' | 'maxOutputTokens'>
}): { [modelName: string]: ModelUsage } {
  return notBuilt('src/cost-tracker.ts:209')
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
  return notBuilt('src/cost-tracker.ts:333')
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
import { notBuilt, type Unbuilt } from './pi/holes.js'
export { readUsageHistory, type UsageHistoryReport, type UsageTotals } from './services/usage/usageHistory.js'
