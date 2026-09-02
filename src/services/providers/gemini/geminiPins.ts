
export interface GeminiPriceTier {
  costInPerMtok: number
  costOutPerMtok: number
  cachedInPerMtok?: number
}

export const GEMINI_PRICING_PAGE = 'https://ai.google.dev/gemini-api/docs/pricing'

export interface GeminiPricePin extends GeminiPriceTier {
  id: string
  observedAt: string
  source: string
  longPrompt?: GeminiPriceTier & { promptTokensAbove: number }
  announced?: GeminiPriceTier & { effectiveOn: string }
}

const LONG_PROMPT_THRESHOLD = 200_000

export const GEMINI_PRICE_PINS: readonly GeminiPricePin[] = [
  {
    id: 'gemini-3.7-flash',
    observedAt: '2026-09-01',
    source: GEMINI_PRICING_PAGE,
    costInPerMtok: 0.75,
    costOutPerMtok: 3.75,
    cachedInPerMtok: 0.075,
    announced: { effectiveOn: '2027-01-01', costInPerMtok: 1.5, costOutPerMtok: 7.5, cachedInPerMtok: 0.15 },
  },
  {
    id: 'gemini-3.6-flash',
    observedAt: '2026-09-01',
    source: GEMINI_PRICING_PAGE,
    costInPerMtok: 0.75,
    costOutPerMtok: 3.75,
    cachedInPerMtok: 0.075,
    announced: { effectiveOn: '2027-01-01', costInPerMtok: 1.5, costOutPerMtok: 7.5, cachedInPerMtok: 0.15 },
  },
  { id: 'gemini-3.5-flash', observedAt: '2026-09-01', source: GEMINI_PRICING_PAGE, costInPerMtok: 1.5, costOutPerMtok: 9, cachedInPerMtok: 0.15 },
  { id: 'gemini-3.5-flash-lite', observedAt: '2026-09-01', source: GEMINI_PRICING_PAGE, costInPerMtok: 0.3, costOutPerMtok: 2.5, cachedInPerMtok: 0.03 },
  { id: 'gemini-3.1-flash-lite', observedAt: '2026-09-01', source: GEMINI_PRICING_PAGE, costInPerMtok: 0.25, costOutPerMtok: 1.5, cachedInPerMtok: 0.025 },
  {
    id: 'gemini-3.1-pro-preview',
    observedAt: '2026-09-01',
    source: GEMINI_PRICING_PAGE,
    costInPerMtok: 2,
    costOutPerMtok: 12,
    cachedInPerMtok: 0.2,
    longPrompt: { promptTokensAbove: LONG_PROMPT_THRESHOLD, costInPerMtok: 4, costOutPerMtok: 18, cachedInPerMtok: 0.4 },
  },
  { id: 'gemini-3-flash-preview', observedAt: '2026-09-01', source: GEMINI_PRICING_PAGE, costInPerMtok: 0.5, costOutPerMtok: 3, cachedInPerMtok: 0.05 },
  {
    id: 'gemini-2.5-pro',
    observedAt: '2026-09-01',
    source: GEMINI_PRICING_PAGE,
    costInPerMtok: 1.25,
    costOutPerMtok: 10,
    cachedInPerMtok: 0.125,
    longPrompt: { promptTokensAbove: LONG_PROMPT_THRESHOLD, costInPerMtok: 2.5, costOutPerMtok: 15, cachedInPerMtok: 0.25 },
  },
  { id: 'gemini-2.5-flash', observedAt: '2026-09-01', source: GEMINI_PRICING_PAGE, costInPerMtok: 0.3, costOutPerMtok: 2.5, cachedInPerMtok: 0.03 },
  { id: 'gemini-2.5-flash-lite', observedAt: '2026-09-01', source: GEMINI_PRICING_PAGE, costInPerMtok: 0.1, costOutPerMtok: 0.4, cachedInPerMtok: 0.01 },
]

export function geminiPricePin(model: string): GeminiPricePin | undefined {
  const lower = model.trim().toLowerCase()
  return GEMINI_PRICE_PINS.find(p => p.id === lower)
}

export function geminiPriceTierFor(
  pin: GeminiPricePin,
  promptTokens: number | undefined,
  today: string = new Date().toISOString().slice(0, 10),
): GeminiPriceTier {
  const tierOf = (t: GeminiPriceTier): GeminiPriceTier => ({
    costInPerMtok: t.costInPerMtok,
    costOutPerMtok: t.costOutPerMtok,
    ...(t.cachedInPerMtok !== undefined ? { cachedInPerMtok: t.cachedInPerMtok } : {}),
  })
  if (pin.longPrompt !== undefined && promptTokens !== undefined && promptTokens > pin.longPrompt.promptTokensAbove) {
    return tierOf(pin.longPrompt)
  }
  if (pin.announced !== undefined && today >= pin.announced.effectiveOn) {
    return tierOf(pin.announced)
  }
  return tierOf(pin)
}
