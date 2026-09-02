import { formatLaneSpend, formatSessionCost, formatTotalCost, getModelUsage, getUnpricedTurns } from '../../cost-tracker.js'
import { currentLimits } from '../../services/claudeAiLimits.js'
import { declaredRouteOf, laneLabelForVerdict, PROVIDER_ID_SPACES } from '../../services/providers/callModelRouter.js'
import { providerDisplayName } from '../../services/providers/routeLaw.js'
import { providerUsageView, type ProviderSessionSpend } from '../../services/providers/providerUsage.js'
import type { LocalCommandResult } from '../../types/command.js'
import { isClaudeAISubscriber } from '../../utils/auth.js'
import { modelPricingBasis } from '../../utils/modelCost.js'

function laneSpendFigure(
  models: readonly string[],
  costUSD: number,
  unpriced: { [modelName: string]: number },
): string {
  let estimatedModels = 0
  let unpricedModels = 0
  let unpricedTurns = 0
  for (const model of models) {
    const turns = unpriced[model] ?? 0
    if (turns > 0) {
      unpricedModels += 1
      unpricedTurns += turns
      continue
    }
    const basis = modelPricingBasis(model)
    if (basis === 'floor' || basis === 'family-estimate') estimatedModels += 1
  }
  const spend: Pick<ProviderSessionSpend, 'costUSD' | 'pricing'> = {
    costUSD,
    ...(estimatedModels > 0 || unpricedTurns > 0 ? { pricing: { estimatedModels, unpricedModels, unpricedTurns } } : {}),
  }
  return formatLaneSpend(spend)
}

export interface CostLaneReads {
  usage?: () => ReturnType<typeof getModelUsage>
  openaiView?: () => ReturnType<typeof providerUsageView>
  unpricedTurns?: () => { [modelName: string]: number }
}

export function nonAnthropicLaneLines(reads: CostLaneReads = {}): string[] {
  const lines: string[] = []
  const openai = (reads.openaiView ?? (() => providerUsageView('openai')))()
  if (openai.sessionSpend.models > 0) {
    const spend = openai.sessionSpend
    const tokens = `${spend.inputTokens.toLocaleString()} in · ${spend.outputTokens.toLocaleString()} out`
    const active = openai.activeEntry
    lines.push(
      active?.kind === 'subscription-oauth'
        ? `OpenAI (${active.label}): ${tokens} — covered by that subscription (${formatSessionCost(spend.costUSD, spend.pricing?.unpricedTurns ?? 0)} at published API rates, an estimate, not a bill)`
        : `OpenAI (${active?.label ?? 'API key'}): ${tokens} — ${formatLaneSpend(spend)}`,
    )
  }
  const usage = (reads.usage ?? getModelUsage)()
  const unpriced = (reads.unpricedTurns ?? getUnpricedTurns)()
  for (const space of PROVIDER_ID_SPACES) {
    if (space.route === 'openai') continue
    let laneIn = 0
    let laneOut = 0
    let laneCost = 0
    const laneModels: string[] = []
    for (const [model, record] of Object.entries(usage)) {
      if (declaredRouteOf(model) !== space.route) continue
      laneModels.push(model)
      laneIn += record.inputTokens + record.cacheReadInputTokens
      laneOut += record.outputTokens
      laneCost += record.costUSD
    }
    if (laneModels.length > 0) {
      const figure = laneSpendFigure(laneModels, laneCost, unpriced)
      const spelled = laneCost > 0 || laneModels.some(model => (unpriced[model] ?? 0) > 0)
      lines.push(
        `${providerDisplayName(space.route)}: ${laneIn.toLocaleString()} in · ${laneOut.toLocaleString()} out${spelled ? ` — ${figure}` : ''}`,
      )
    }
  }
  {
    let laneIn = 0
    let laneOut = 0
    let laneCost = 0
    const laneModels: string[] = []
    for (const [model, record] of Object.entries(usage)) {
      if (declaredRouteOf(model) !== null) continue
      laneModels.push(model)
      laneIn += record.inputTokens + record.cacheReadInputTokens
      laneOut += record.outputTokens
      laneCost += record.costUSD
    }
    if (laneModels.length > 0) {
      const spelled = laneCost > 0 || laneModels.some(model => (unpriced[model] ?? 0) > 0)
      lines.push(
        `${laneLabelForVerdict({ kind: 'unrecognised', carrierShaped: false }, { rode: true })}: ${laneIn.toLocaleString()} in · ${laneOut.toLocaleString()} out${spelled ? ` — ${laneSpendFigure(laneModels, laneCost, unpriced)}` : ''}`,
      )
    }
  }
  return lines
}

export const call = async (): Promise<LocalCommandResult> => {
  const laneLines = nonAnthropicLaneLines()
  if (isClaudeAISubscriber()) {
    const anthropic = currentLimits.isUsingOverage
      ? "Anthropic says this account's usage is currently billed to its extra-usage pool — subscription rate limits resume automatically when they reset."
      : 'Anthropic: usage is covered by your subscription.'
    return { type: 'text', value: [anthropic, ...laneLines].join('\n') }
  }
  return {
    type: 'text',
    value: laneLines.length > 0 ? `${formatTotalCost()}\n${laneLines.join('\n')}` : formatTotalCost(),
  }
}
