// ============================================================================
//  providers/gemini/geminiPins — the PURE Gemini price pins. Zero imports BY
//  DESIGN (the gptPins convention): the pricing owner (utils/modelCost) reads
//  this table and low-level utils stay bun-loadable.
//
//  WHICH models exist is the live models.list answer (geminiCatalogue — no
//  pins there); WHAT they cost is not on that wire, so the ledger prices a
//  Gemini turn from this table of the official pricing page, read on the
//  date each row carries (ai.google.dev/gemini-api/docs/pricing, fetched
//  2026-09-01; the paid tier; the text/image/video input rate — Mercury sends
//  no audio). Before this table a Gemini turn was priced at another vendor's
//  tier under the unknown-cost flag.
//
//  Laws:
//    - never guessed, never invented — an id the page does not state is
//      UNPRICED (the ledger says so), never a neighbour's rate;
//    - a row that states a longer-prompt tier prices the REQUEST by the
//      prompt it sent (every input-side token counts toward the threshold);
//    - a row whose price the page announces as changing on a date carries
//      both figures; the owner picks by the day.
// ============================================================================

export interface GeminiPriceTier {
  /** USD per million tokens. */
  costInPerMtok: number
  costOutPerMtok: number
  /** The page's context-caching read rate; absent where it states none. */
  cachedInPerMtok?: number
}

/** The page every row was read from — cited beside each pin with its date. */
export const GEMINI_PRICING_PAGE = 'https://ai.google.dev/gemini-api/docs/pricing'

export interface GeminiPricePin extends GeminiPriceTier {
  /** The model id exactly as the page states it (the wire's spelling). */
  id: string
  /** Date (YYYY-MM-DD) the row was last read on the pricing page. */
  observedAt: string
  /** The page the row was read from (GEMINI_PRICING_PAGE). */
  source: string
  /** The longer-prompt tier the page states for this row: applies when the
   *  prompt (uncached + cached input) EXCEEDS promptTokensAbove. */
  longPrompt?: GeminiPriceTier & { promptTokensAbove: number }
  /** A price change the page announces for a date (inclusive). */
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

/** The published price row for a Gemini id (exact id, case-insensitive);
 *  undefined for an id the page does not state — the ledger leaves it
 *  unpriced. */
export function geminiPricePin(model: string): GeminiPricePin | undefined {
  const lower = model.trim().toLowerCase()
  return GEMINI_PRICE_PINS.find(p => p.id === lower)
}

/** The tier a request prices at: the longer-prompt tier when the prompt
 *  exceeds the row's threshold, the announced figures once their date has
 *  come (an announced change and a long-prompt tier never coincide on the
 *  page today; the long-prompt tier wins when both are stated), else the
 *  base row. `today` is an ISO date (YYYY-MM-DD). */
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
