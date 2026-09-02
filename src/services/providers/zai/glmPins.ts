
export const GLM_MODEL_EFFORTS: Readonly<Record<string, ReadonlySet<string>>> = {
  'glm-5.2': new Set(['max', 'xhigh', 'high', 'medium', 'low', 'minimal', 'none']),
  'glm-5.3': new Set(['low', 'high', 'max']),
}

export const GLM_EFFORT_MODELS: ReadonlySet<string> = new Set(Object.keys(GLM_MODEL_EFFORTS))

export const GLM_EFFORTS: ReadonlySet<string> = new Set(
  Object.values(GLM_MODEL_EFFORTS).flatMap(s => [...s]),
)

export function glmEffortsFor(model: string): ReadonlySet<string> | undefined {
  return GLM_MODEL_EFFORTS[model.trim().toLowerCase()]
}

export function isGlmModelId(model: string): boolean {
  const m = model.trim().toLowerCase()
  return m === 'glm' || m.startsWith('glm-')
}

export function glmAcceptsEffort(model: string, effort: string): boolean {
  return glmEffortsFor(model)?.has(effort) === true
}

export function glmThinkingLocked(model: string): boolean {
  return model.trim().toLowerCase() === 'glm-5.3'
}


export const GLM_PRICING_PAGE = 'https://docs.z.ai/guides/overview/pricing'

export interface GlmPricePin {
  id: string
  observedAt: string
  source: string
  costInPerMtok: number
  costOutPerMtok: number
  cachedInPerMtok?: number
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

export function glmPricePin(model: string): GlmPricePin | undefined {
  const lower = model.trim().toLowerCase()
  return GLM_PRICE_PINS.find(p => p.id === lower)
}
