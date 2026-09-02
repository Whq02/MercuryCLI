// ============================================================================
//  providers/zai/glmPins — the PURE GLM effort-vocabulary facts (
//  glm-5.3 added by the provider-08-21). Zero imports BY DESIGN
//  (the gptPins convention): the capability edge (utils/model/capabilities.ts)
//  and the zai wire (zaiCallModel.ts) must rank effort from the SAME
//  documented vocabulary — before this module the wire accepted 'max' for
//  glm-5.2 while the display tables clamped max→high (the display/dispatch-
//  divergence class, RED probe).
//
//  Vocabularies are PER MODEL:
//    · glm-5.2 — reasoning_effort max|xhigh|high|medium|low|minimal|none
//
//    · glm-5.3 — reasoning_effort low|high|max ONLY (default max), and
//      reasoning CANNOT be disabled ("Disabling reasoning is not
//      supported" — a thinking.type:'disabled' request FAILS on glm-5.3).
// ============================================================================

/** Per-model documented reasoning_effort vocabularies (dated observations —
 *  the header carries the fetch dates; verify live before extending). */
export const GLM_MODEL_EFFORTS: Readonly<Record<string, ReadonlySet<string>>> = {
  'glm-5.2': new Set(['max', 'xhigh', 'high', 'medium', 'low', 'minimal', 'none']),
  'glm-5.3': new Set(['low', 'high', 'max']),
}

/** The models with a documented reasoning_effort vocabulary. */
export const GLM_EFFORT_MODELS: ReadonlySet<string> = new Set(Object.keys(GLM_MODEL_EFFORTS))

/** The UNION vocabulary (compat export — per-model truth is
 *  {@link glmEffortsFor}; membership checks must go per-model). */
export const GLM_EFFORTS: ReadonlySet<string> = new Set(
  Object.values(GLM_MODEL_EFFORTS).flatMap(s => [...s]),
)

/** The documented vocabulary for one model (undefined = none documented). */
export function glmEffortsFor(model: string): ReadonlySet<string> | undefined {
  return GLM_MODEL_EFFORTS[model.trim().toLowerCase()]
}

/** True iff this id is a GLM engine id (the zai wire's model family). */
export function isGlmModelId(model: string): boolean {
  const m = model.trim().toLowerCase()
  return m === 'glm' || m.startsWith('glm-')
}

/** True iff the documented GLM vocabulary accepts `effort` for `model` —
 *  exactly the wire's send condition (zaiCallModel), consumed by the
 *  capability edge so display truth equals dispatch truth. */
export function glmAcceptsEffort(model: string, effort: string): boolean {
  return glmEffortsFor(model)?.has(effort) === true
}

/** True iff the documented API REFUSES thinking.type:'disabled' for this
 *  model — the wire must send 'enabled'
 *  regardless of the session's thinking config or the request fails. */
export function glmThinkingLocked(model: string): boolean {
  return model.trim().toLowerCase() === 'glm-5.3'
}

// ── the published prices ────────────────────────────────────────────────────
//  docs.z.ai/guides/overview/pricing, fetched 2026-09-01: the table's columns
//  are Model | Input | Cached Input | Cached Input Storage | Output, USD per
//  1M tokens; every text row states "Limited-time Free" cache storage, so a
//  cache WRITE costs the input rate and nothing more (the pinned-engine
//  convention). The ledger prices a GLM turn at these rates through
//  modelCost's per-route pricing owner — before this table a GLM turn was
//  priced at another vendor's tier under the unknown-cost flag. Vision rows
//  are deliberately unpinned (not chat rows here); an id the page does not
//  state stays UNPRICED, never an invented rate.

/** The page every row was read from — cited beside each pin with its date. */
export const GLM_PRICING_PAGE = 'https://docs.z.ai/guides/overview/pricing'

export interface GlmPricePin {
  id: string
  /** Date (YYYY-MM-DD) the row was last read on the pricing page. */
  observedAt: string
  /** The page the row was read from (GLM_PRICING_PAGE). */
  source: string
  /** USD per million tokens, as the page states them. */
  costInPerMtok: number
  costOutPerMtok: number
  /** The page's "Cached Input" column; absent where the page states none. */
  cachedInPerMtok?: number
  /** The page shows a struck list price beside a limited-time one — the
   *  billed (limited-time) figure is pinned above; the list is kept here. */
  listPriceNote?: string
}

export const GLM_PRICE_PINS: readonly GlmPricePin[] = [
  { id: 'glm-5.3', observedAt: '2026-09-01', source: GLM_PRICING_PAGE, costInPerMtok: 1.4, costOutPerMtok: 4.4, cachedInPerMtok: 0.26 },
  {
    id: 'glm-5.3-flash',
    observedAt: '2026-09-01',
    source: GLM_PRICING_PAGE,
    costInPerMtok: 0.075,
    costOutPerMtok: 0.25,
    cachedInPerMtok: 0.015,
    listPriceNote: 'list $0.15 in / $0.03 cached / $0.50 out, struck through for a limited-time price',
  },
  { id: 'glm-5.2', observedAt: '2026-09-01', source: GLM_PRICING_PAGE, costInPerMtok: 1.4, costOutPerMtok: 4.4, cachedInPerMtok: 0.26 },
  { id: 'glm-5.1', observedAt: '2026-09-01', source: GLM_PRICING_PAGE, costInPerMtok: 1.4, costOutPerMtok: 4.4, cachedInPerMtok: 0.26 },
  { id: 'glm-5', observedAt: '2026-09-01', source: GLM_PRICING_PAGE, costInPerMtok: 1, costOutPerMtok: 3.2, cachedInPerMtok: 0.2 },
  { id: 'glm-4.7', observedAt: '2026-09-01', source: GLM_PRICING_PAGE, costInPerMtok: 0.6, costOutPerMtok: 2.2, cachedInPerMtok: 0.11 },
  { id: 'glm-4.7-flashx', observedAt: '2026-09-01', source: GLM_PRICING_PAGE, costInPerMtok: 0.07, costOutPerMtok: 0.4, cachedInPerMtok: 0.01 },
  { id: 'glm-4.7-flash', observedAt: '2026-09-01', source: GLM_PRICING_PAGE, costInPerMtok: 0, costOutPerMtok: 0, cachedInPerMtok: 0 },
  { id: 'glm-4.6', observedAt: '2026-09-01', source: GLM_PRICING_PAGE, costInPerMtok: 0.6, costOutPerMtok: 2.2, cachedInPerMtok: 0.11 },
  { id: 'glm-4.5', observedAt: '2026-09-01', source: GLM_PRICING_PAGE, costInPerMtok: 0.6, costOutPerMtok: 2.2, cachedInPerMtok: 0.11 },
  { id: 'glm-4.5-x', observedAt: '2026-09-01', source: GLM_PRICING_PAGE, costInPerMtok: 2.2, costOutPerMtok: 8.9, cachedInPerMtok: 0.45 },
  { id: 'glm-4.5-air', observedAt: '2026-09-01', source: GLM_PRICING_PAGE, costInPerMtok: 0.2, costOutPerMtok: 1.1, cachedInPerMtok: 0.03 },
  { id: 'glm-4.5-airx', observedAt: '2026-09-01', source: GLM_PRICING_PAGE, costInPerMtok: 1.1, costOutPerMtok: 4.5, cachedInPerMtok: 0.22 },
  { id: 'glm-4.5-flash', observedAt: '2026-09-01', source: GLM_PRICING_PAGE, costInPerMtok: 0, costOutPerMtok: 0, cachedInPerMtok: 0 },
  { id: 'glm-4-32b-0414-128k', observedAt: '2026-09-01', source: GLM_PRICING_PAGE, costInPerMtok: 0.1, costOutPerMtok: 0.1 },
]

/** The published price row for a GLM id (case-insensitive); undefined for
 *  an id the page does not state — the ledger leaves it unpriced. */
export function glmPricePin(model: string): GlmPricePin | undefined {
  const lower = model.trim().toLowerCase()
  return GLM_PRICE_PINS.find(p => p.id === lower)
}
