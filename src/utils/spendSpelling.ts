// The spend spelling: one formatter for every cost figure the product shows, a
// pure leaf the faces may import - the accumulators stay in the cost tracker.
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

/**
 * THE one spelling of a USD figure that may include unpriced turns (the
 * usage-neutrality law): a figure with no priced spend beside unpriced
 * turns is "unpriced" — never a $0.00 that reads as free — and a figure
 * that includes such turns says so beside itself ("$1.23 + 3 unpriced
 * turns"). Every cost readout (the /cost headline and rows, the per-lane
 * spend lines, the deck and frame vitals) spells its figure through here.
 */
export function formatSessionCost(costUSD: number, unpricedTurns: number): string {
  if (unpricedTurns <= 0) return formatCost(costUSD)
  const turns = `${unpricedTurns} unpriced ${unpricedTurns === 1 ? 'turn' : 'turns'}`
  return costUSD > 0
    ? `${formatCost(costUSD)} + ${turns}`
    : `unpriced (${turns} — no rate on file, tokens counted)`
}

/** A lane's spend figure in the same law, with the estimate mark the lane's
 *  pricing basis carries (a listed floor, a same-family estimate). */
export function formatLaneSpend(spend: Pick<ProviderSessionSpend, 'costUSD' | 'pricing'>): string {
  const figure = formatSessionCost(spend.costUSD, spend.pricing?.unpricedTurns ?? 0)
  const estimated = spend.pricing?.estimatedModels ?? 0
  return estimated > 0
    ? `${figure} (${estimated === 1 ? 'one model' : `${estimated} models`} at an estimated rate)`
    : figure
}
