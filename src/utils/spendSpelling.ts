import type { ProviderSessionSpend } from '../services/providers/providerUsage.js'

export const DEFAULT_COST_DECIMAL_PLACES = 4

export function formatCost(
  cost: number,
  maxDecimalPlaces: number = DEFAULT_COST_DECIMAL_PLACES,
): string {
  if (cost > 0.5) {
    return `$${cost.toFixed(2)}`
  }
  return `$${cost.toFixed(maxDecimalPlaces)}`
}

export function formatSessionCost(costUSD: number, unpricedTurns: number): string {
  if (unpricedTurns <= 0) return formatCost(costUSD)
  const turns = `${unpricedTurns} unpriced ${unpricedTurns === 1 ? 'turn' : 'turns'}`
  return costUSD > 0
    ? `${formatCost(costUSD)} + ${turns}`
    : `unpriced (${turns} — no rate on file, tokens counted)`
}

export function formatLaneSpend(spend: Pick<ProviderSessionSpend, 'costUSD' | 'pricing'>): string {
  const figure = formatSessionCost(spend.costUSD, spend.pricing?.unpricedTurns ?? 0)
  const estimated = spend.pricing?.estimatedModels ?? 0
  return estimated > 0
    ? `${figure} (${estimated === 1 ? 'one model' : `${estimated} models`} at an estimated rate)`
    : figure
}
