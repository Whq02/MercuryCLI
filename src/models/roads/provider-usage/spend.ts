import { getModelUsage, getUnpricedTurns, getWorkloadUnpricedTurns, getWorkloadUsage, type ModelUsage } from '../../../boot/process-state/processState.js'
import type { ModelSpendRowV1, UsageFactsV1 } from '../../../engine/connector/types.js'
import { formatLaneSpend } from '../spendSpelling.js'
import { formatTokens } from '../../../platform/text/format.js'
import { WORKLOAD_ADVISOR, WORKLOAD_CRON } from '../workloadContext.js'
import { modelPricingBasis } from '../../usage/modelCost.js'
import { declaredRouteOf } from '../routeLaw.js'
import type { ProviderFamilyId } from '../providerAdapter.js'
import type { ModelSessionSpend, ProviderSessionSpend } from '../providerUsage.js'

export function providerSessionSpend(route: ProviderFamilyId): ProviderSessionSpend {
  return spendForRoute(route)
}

export function spendForRoute(route: ProviderFamilyId | 'unrecognised'): ProviderSessionSpend {
  const admit = (model: string): boolean => (declaredRouteOf(model) ?? 'unrecognised') === route
  const spend = spendOf(getModelUsage(), getUnpricedTurns(), admit)
  const scheduled = spendOf(scheduledUsage(), scheduledUnpricedTurns(), admit)
  if (scheduled.models > 0) spend.scheduled = scheduled
  const advisor = spendOf(advisorUsage(), advisorUnpricedTurns(), admit)
  if (advisor.models > 0) spend.advisor = advisor
  return spend
}

function spendOfRows(rows: readonly ModelSpendRowV1[], admit: (model: string) => boolean): ProviderSessionSpend {
  const usage: { [modelName: string]: ModelUsage } = {}
  const unpriced: { [modelName: string]: number } = {}
  for (const row of rows) {
    const record = usage[row.model] ?? { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, webSearchRequests: 0, costUSD: 0 }
    record.inputTokens += row.inputTokens
    record.outputTokens += row.outputTokens
    record.cacheReadInputTokens += row.cacheReadInputTokens
    record.cacheCreationInputTokens += row.cacheCreationInputTokens
    record.costUSD += row.costUSD
    usage[row.model] = record
    if (row.unpricedTurns > 0) unpriced[row.model] = (unpriced[row.model] ?? 0) + row.unpricedTurns
  }
  return spendOf(usage, unpriced, admit)
}

export function sessionSpendOfFacts(
  facts: Pick<UsageFactsV1, 'modelSpend'>,
  route: ProviderFamilyId | 'unrecognised',
): ProviderSessionSpend | null {
  if (facts.modelSpend === undefined) return null
  const admit = (model: string): boolean => (declaredRouteOf(model) ?? 'unrecognised') === route
  const spend = spendOfRows(facts.modelSpend.filter(row => row.workload === undefined), admit)
  const scheduled = spendOfRows(facts.modelSpend.filter(row => row.workload === WORKLOAD_CRON), admit)
  if (scheduled.models > 0) spend.scheduled = scheduled
  const advisor = spendOfRows(facts.modelSpend.filter(row => row.workload === WORKLOAD_ADVISOR), admit)
  if (advisor.models > 0) spend.advisor = advisor
  return spend
}

export function sessionSpendByModel(
  facts: Pick<UsageFactsV1, 'modelSpend'>,
  route: ProviderFamilyId | 'unrecognised',
): ModelSessionSpend[] {
  if (facts.modelSpend === undefined) return []
  const own = facts.modelSpend.filter(row => row.workload === undefined && (declaredRouteOf(row.model) ?? 'unrecognised') === route)
  const out: ModelSessionSpend[] = []
  for (const row of own) {
    if (out.some(entry => entry.model === row.model)) continue
    out.push({ model: row.model, spend: spendOfRows(own.filter(r => r.model === row.model), () => true) })
  }
  return out
}

function scheduledUsage(): { [modelName: string]: ModelUsage } {
  return getWorkloadUsage()[WORKLOAD_CRON] ?? {}
}

function scheduledUnpricedTurns(): { [modelName: string]: number } {
  return getWorkloadUnpricedTurns()[WORKLOAD_CRON] ?? {}
}

function advisorUsage(): { [modelName: string]: ModelUsage } {
  return getWorkloadUsage()[WORKLOAD_ADVISOR] ?? {}
}

function advisorUnpricedTurns(): { [modelName: string]: number } {
  return getWorkloadUnpricedTurns()[WORKLOAD_ADVISOR] ?? {}
}

export function scheduledSessionSpend(): ProviderSessionSpend {
  return spendOf(scheduledUsage(), scheduledUnpricedTurns(), () => true)
}

export function advisorSessionSpend(): ProviderSessionSpend {
  return spendOf(advisorUsage(), advisorUnpricedTurns(), () => true)
}

export const ADVISOR_WORK_WORD = 'advisor'

export function advisorUsageLine(): string | null {
  const spend = advisorSessionSpend()
  if (spend.models === 0) return null
  return `${ADVISOR_WORK_WORD} ${formatTokens(spend.inputTokens + spend.outputTokens)} spent · ${formatLaneSpend(spend)}`
}

export const SCHEDULED_WORK_WORD = 'scheduled'

export function scheduledUsageLine(): string | null {
  const spend = scheduledSessionSpend()
  if (spend.models === 0) return null
  return `${SCHEDULED_WORK_WORD} ${formatTokens(spend.inputTokens + spend.outputTokens)} spent · ${formatLaneSpend(spend)}`
}

function spendOf(
  usage: { [modelName: string]: ModelUsage },
  unpriced: { [modelName: string]: number },
  admit: (model: string) => boolean,
): ProviderSessionSpend {
  const spend: ProviderSessionSpend = { inputTokens: 0, outputTokens: 0, costUSD: 0, models: 0 }
  let estimatedModels = 0
  let unpricedModels = 0
  let unpricedTurns = 0
  for (const [model, record] of Object.entries(usage)) {
    if (!admit(model)) continue
    spend.models += 1
    spend.inputTokens += record.inputTokens + record.cacheReadInputTokens + record.cacheCreationInputTokens
    spend.outputTokens += record.outputTokens
    spend.costUSD += record.costUSD
    const turns = unpriced[model] ?? 0
    if (turns > 0) {
      unpricedModels += 1
      unpricedTurns += turns
    } else {
      const basis = modelPricingBasis(model)
      if (basis === 'floor' || basis === 'family-estimate') estimatedModels += 1
    }
  }
  if (estimatedModels > 0 || unpricedTurns > 0) spend.pricing = { estimatedModels, unpricedModels, unpricedTurns }
  return spend
}
