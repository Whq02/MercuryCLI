// ============================================================================
//  providers/deepseek/deepseekPins — the PURE DeepSeek grammar + the
//  LAST-OBSERVED display pins. Zero imports BY
//  DESIGN (the gptPins convention).
//
//  Laws (the gptPins laws verbatim): pins are dated last-observed records of
//  the official docs, never eternal truth; absent fields mean "no official
//  fact recorded"; readers present pin facts as observed-on-this-date.
//  Sources: api-docs.deepseek.com/quick_start/pricing,
//  api-docs.deepseek.com/api/create-chat-completion,
//  api-docs.deepseek.com/api/get-user-balance (the LANE-RECEIPT lists them).
//
//  Lineage note: the legacy ids deepseek-chat /
//  deepseek-reasoner were retired (the change log; they briefly
//  aliased onto deepseek-v4-flash) — they never enter this table.
// ============================================================================

/** True iff this id rides the DeepSeek lane (the routing-law family). */
export function isDeepseekModelId(model: string): boolean {
  const m = model.trim().toLowerCase()
  return m === 'deepseek' || m.startsWith('deepseek-')
}

/** The documented thinking reasoning_effort vocabulary (create-chat-completion
 *  page, observed): `thinking: { type, reasoning_effort }` with
 *  low|high|max; flash and pro both support thinking (default) and
 *  non-thinking modes. */
export const DEEPSEEK_EFFORTS: ReadonlySet<string> = new Set(['low', 'high', 'max'])

export function deepseekAcceptsEffort(model: string, effort: string): boolean {
  return isDeepseekModelId(model) && DEEPSEEK_EFFORTS.has(effort)
}

export interface DeepseekDisplayPin {
  id: string
  displayName: string
  /** Date (YYYY-MM-DD) the facts were last fetched from the official docs. */
  observedAt: string
  contextWindow?: number
  outputMax?: number
  /** Peak-hour list prices (the docs state off-peak at 50%). The ledger
   *  prices DeepSeek turns at these rates through modelCost's lane-aware
   *  pin lookup (FN-018 rank 3) — the ceiling of what was billed, since
   *  the off-peak halving is not modelled; /caching displays them too. */
  costInPerMtok?: number
  costOutPerMtok?: number
  cachedInPerMtok?: number
}

// The lineup as last observed on the official pricing page (fetched
// THREE served models, all "1M" context with "MAXIMUM: 384K"
// output — two are pinned below; the third, deepseek-v4-flash-vision-exp,
// is DELIBERATELY unpinned (experimental vision variant, not a picker
// row). Prices below are the PEAK rates per 1M tokens (off-peak is halved).
export const DEEPSEEK_DISPLAY_PINS: readonly DeepseekDisplayPin[] = [
  {
    id: 'deepseek-v4-pro',
    displayName: 'DeepSeek V4 Pro',
    observedAt: '2026-08-21',
    contextWindow: 1_000_000,
    outputMax: 384_000,
    costInPerMtok: 1.32,
    costOutPerMtok: 3.96,
    cachedInPerMtok: 0.044,
  },
  {
    id: 'deepseek-v4-flash',
    displayName: 'DeepSeek V4 Flash',
    observedAt: '2026-08-21',
    contextWindow: 1_000_000,
    outputMax: 384_000,
    costInPerMtok: 0.44,
    costOutPerMtok: 1.32,
    cachedInPerMtok: 0.014,
  },
]

export function deepseekDisplayPin(id: string): DeepseekDisplayPin | undefined {
  const lower = id.trim().toLowerCase()
  return DEEPSEEK_DISPLAY_PINS.find(p => p.id === lower)
}

/** Display name for a DeepSeek id: the pin's, else a mechanical title, else
 *  undefined for non-DeepSeek ids. */
export function deepseekDisplayName(id: string): string | undefined {
  const pin = deepseekDisplayPin(id)
  if (pin) return pin.displayName
  if (!isDeepseekModelId(id)) return undefined
  return id
    .trim()
    .toLowerCase()
    .split('-')
    .map(part => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ')
}
