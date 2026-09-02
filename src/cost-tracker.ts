// ============================================================================
//  src/cost-tracker.ts — the session cost/usage ledger surface: accumulation
//  per model, persistence into the project config, restore on resume, and
//  the human-readable cost summary.
//
//  The mutable ledger itself lives on the runtime-state facade; this module
//  is the single import point callers use for cost concerns, plus the
//  behaviour that is genuinely its own (the per-model fold, persistence
//  round-trip and formatting).
// ============================================================================
import chalk from 'chalk'
import { mapValues } from 'lodash-es'
import {
  addToTotalCostState,
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
  hasUnknownModelCost,
  recordUnpricedTurn,
  setCostStateForRestore,
} from './bootstrap/state.js'
import type { ModelUsage } from './entrypoints/agentSdkTypes.js'
import type { NonNullableUsage } from './services/api/logging.js'
import type { ProviderSessionSpend } from './services/providers/providerUsage.js'
import { formatCost, formatSessionCost, formatLaneSpend } from './utils/spendSpelling.js'
export { formatCost, formatSessionCost, formatLaneSpend }
import { getAdvisorUsage } from './utils/advisor.js'
import { getCurrentProjectConfig, saveCurrentProjectConfig } from './utils/config.js'
import { formatDuration, formatNumber } from './utils/format.js'
import type { FpsMetrics } from './utils/fpsTracker.js'
import { calculateUSDCost, modelPricingBasis } from './utils/modelCost.js'
import { getCanonicalName } from './utils/model/model.js'
import {
  getContextWindowForModel,
  getModelMaxOutputTokens,
} from './utils/model/capabilities.js'
import { recordUsagePulse } from './utils/cockpit/usageActivity.js'

const VALUE_COLUMN = 23
const MODEL_NAME_COLUMN = 21

// Module-private alias; only the value shape is contract.
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
}

/** How the caller arrived at `cost`: 'wire-stated' = the provider's own
 *  figure for this response (an OpenRouter usage line) — a price whatever
 *  the pricing owner holds for the id. Absent = the pricing owner priced
 *  it, and its basis decides whether the turn counts as unpriced. */
export type LedgerCostBasis = { basis: 'wire-stated' }

/**
 * Fold one settled provider response into the per-model ledger. Cost
 * accumulates; the per-model record is refreshed (context window for the
 * current SDK betas, default max output tokens) and committed wholesale.
 * Each settled response contributes exactly one activity pulse. Advisor
 * usage carried by the response recurses with each advisor's own model, and
 * the returned value is the sum of this call's cost and every advisor cost.
 * A turn the pricing owner could not price (no rate on file) is COUNTED as
 * unpriced beside its tokens — its zero never poses as a bill (the
 * usage-neutrality law: honest absence, never a foreign rate, never free).
 */
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
  if (pricing?.basis !== 'wire-stated' && modelPricingBasis(model) === 'unpriced') {
    recordUnpricedTurn(model)
  }
  recordUsagePulse(cost)

  let total = cost
  for (const advisorUsage of getAdvisorUsage(usage)) {
    const advisorCost = calculateUSDCost(advisorUsage.model, advisorUsage)
    total += addToTotalSessionCost(advisorCost, advisorUsage, advisorUsage.model)
  }
  return total
}

/**
 * Persist the session's cost totals into the project config. The window
 * label distinguishes this record — cumulative across resumes of one
 * session id — from the per-process frame-rate metrics stored under sibling
 * keys. The label's session-id read is wrapped so an early-boot caller
 * still gets a labelled, timestamped window; the `lastSessionId` write is
 * deliberately not wrapped.
 */
/**
 * True once this process metered any model usage. The bare-boot gate for
 * the per-project exit rows (the folder-as-project law): a boot that only
 * looked at the menu and quit writes no cost row, no session id and no
 * metrics under a folder it never worked in.
 */
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
    // The derived context-window and max-output fields are not persisted;
    // read-back recomputes them for the then-current betas.
    lastModelUsage: mapValues(getModelUsage(), usage => ({
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cacheReadInputTokens: usage.cacheReadInputTokens,
      cacheCreationInputTokens: usage.cacheCreationInputTokens,
      webSearchRequests: usage.webSearchRequests,
      costUSD: usage.costUSD,
    })),
    lastUnpricedTurns: { ...getUnpricedTurns() },
    lastSessionId: getSessionId(),
  }))
}

/**
 * The stored totals for `sessionId`, or undefined when the persisted record
 * belongs to another session. Per-model records are rehydrated with freshly
 * computed context windows and output limits. This is the accessor to use
 * BEFORE overwriting the config with a save.
 */
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
    modelUsage: config.lastModelUsage
      ? mapValues(config.lastModelUsage, (stored, model) => ({
          ...stored,
          contextWindow: getContextWindowForModel(model, getSdkBetas()),
          maxOutputTokens: getModelMaxOutputTokens(model).default,
        }))
      : undefined,
    unpricedTurns: config.lastUnpricedTurns ? { ...config.lastUnpricedTurns } : undefined,
  }
}

/** Apply the stored costs for `sessionId` to the live ledger; reports
 *  whether a restore happened. */
export function restoreCostStateForSession(sessionId: string): boolean {
  const stored = getStoredSessionCosts(sessionId)
  if (!stored) {
    return false
  }
  setCostStateForRestore(stored)
  return true
}

/** `$` + two decimals above half a dollar, otherwise a configurable number
 *  of decimals (default 4). */



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
    return [labelled('Usage:', '0 input, 0 output, 0 cache read, 0 cache write')]
  }
  // Usage from several concrete model ids sharing a canonical short name is
  // summed into one row.
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
  const rows = ['Usage by model:']
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

/** The dimmed multi-line cost summary block. */
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

// One import point for cost concerns: the ledger accessors re-exported from
// the state facade. The total tool duration is read for the save path above
// but deliberately not re-exported.
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
