import { formatLaneSpend, formatSessionCost, formatTotalCost, getModelUsage, getUnpricedTurns } from '../../cost-tracker.js'
import { currentLimits } from '../../services/claudeAiLimits.js'
import { declaredRouteOf, laneLabelForVerdict, PROVIDER_ID_SPACES } from '../../services/providers/callModelRouter.js'
import { providerDisplayName } from '../../services/providers/routeLaw.js'
import { providerUsageView, type ProviderSessionSpend } from '../../services/providers/providerUsage.js'
import type { LocalCommandResult } from '../../types/command.js'
import { isClaudeAISubscriber } from '../../utils/auth.js'
import { modelPricingBasis } from '../../utils/modelCost.js'

/** A lane's spend figure in the ONE law (cost-tracker's formatLaneSpend):
 *  the ledger's own count of the turns it could not price rides beside the
 *  figure ("+ N unpriced turns"; a lane with nothing priced reads
 *  "unpriced", never "$0.00"), and the pricing owner's basis marks an
 *  estimate — a figure is never shown as a bill when it is a floor, a
 *  same-family estimate or an unrecorded rate. */
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

/** Injectable reads for the prover; production passes nothing. */
export interface CostLaneReads {
  usage?: () => ReturnType<typeof getModelUsage>
  openaiView?: () => ReturnType<typeof providerUsageView>
  /** The ledger's unpriced-turn counts per model (the same window as `usage`). */
  unpricedTurns?: () => { [modelName: string]: number }
}

/** Per-lane session totals for the non-Anthropic providers — the OpenAI
 *  lane through the ONE per-provider facade (stage 9: identity + spend from
 *  providerUsageView; the active wallet entry names the billing source).
 *  An OpenAI subscription turn is covered by that subscription (the USD
 *  figure is a published-rate estimate, not a bill); an API-key turn's USD
 *  is the real spend. EVERY other family the routing law declares gets its
 *  own line whenever it ran turns this session — partitioned by the routing
 *  law and named by the one display-name table, never a hand-kept subset
 *  (four families — OpenRouter, Gemini, Hugging Face, local — once had no
 *  line at all while their spend sat in the ledger). */
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
      // A lane that priced nothing and counted unpriced turns still gets
      // its figure — "unpriced (…)" — never a silent row.
      const figure = laneSpendFigure(laneModels, laneCost, unpriced)
      const spelled = laneCost > 0 || laneModels.some(model => (unpriced[model] ?? 0) > 0)
      lines.push(
        `${providerDisplayName(space.route)}: ${laneIn.toLocaleString()} in · ${laneOut.toLocaleString()} out${spelled ? ` — ${figure}` : ''}`,
      )
    }
  }
  // The stranger bucket (paint-time only — stored records never rewrite):
  // usage recorded for an id no family declares can only have ridden the
  // earned gateway, and the row says so — never the Anthropic bucket.
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

/**
 * `/cost` — the session cost, split per provider lane. Anthropic subscribers
 * (whose Claude spend is not per-token) get the pool sentence; the other
 * lanes report their own totals whenever they ran turns this session.
 */
export const call = async (): Promise<LocalCommandResult> => {
  const laneLines = nonAnthropicLaneLines()
  if (isClaudeAISubscriber()) {
    // The overage line is a provider-reported billing state (the wire's
    // overage-status headers), so it speaks in Mercury's attributed frame;
    // "extra usage" is Anthropic's own name for that pool. The subscription
    // line is a lane label like the provider rows below it.
    const anthropic = currentLimits.isUsingOverage
      ? "Anthropic says this account's usage is currently billed to its extra-usage pool — subscription rate limits resume automatically when they reset."
      : 'Anthropic: usage is covered by your subscription.'
    return { type: 'text', value: [anthropic, ...laneLines].join('\n') }
  }
  // Non-subscribers: the full ledger is already provider-neutral (per-model
  // rows include every lane); the lane lines add the billing-source split.
  return {
    type: 'text',
    value: laneLines.length > 0 ? `${formatTotalCost()}\n${laneLines.join('\n')}` : formatTotalCost(),
  }
}
