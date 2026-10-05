
export const GLM_MODEL_EFFORTS: Readonly<Record<string, ReadonlySet<string>>> = {
  'glm-5.2': new Set(['max', 'xhigh', 'high', 'medium', 'low', 'minimal', 'none']),
  'glm-5.3': new Set(['low', 'high', 'max']),
  'glm-5.3-flash': new Set(['low', 'high', 'max']),
  'glm-5.3-flashx': new Set(['low', 'high', 'max']),
}

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

const GLM_THINKING_LOCKED: ReadonlySet<string> = new Set(['glm-5.3', 'glm-5.3-flash', 'glm-5.3-flashx'])

export function glmThinkingLocked(model: string): boolean {
  return GLM_THINKING_LOCKED.has(model.trim().toLowerCase())
}

export interface GlmDisplayPin {
  id: string
  displayName: string
  observedAt: string
  contextWindow?: number
  outputMax?: number
}

export const GLM_DISPLAY_PINS: readonly GlmDisplayPin[] = [
  { id: 'glm-5.3', displayName: 'GLM-5.3', observedAt: '2026-10-05', contextWindow: 1_000_000, outputMax: 131_072 },
  { id: 'glm-5.3-flash', displayName: 'GLM-5.3-Flash', observedAt: '2026-10-05', contextWindow: 1_000_000, outputMax: 131_072 },
  { id: 'glm-5.3-flashx', displayName: 'GLM-5.3-FlashX', observedAt: '2026-10-05', contextWindow: 1_000_000, outputMax: 131_072 },
  { id: 'glm-5.2', displayName: 'GLM-5.2', observedAt: '2026-10-05', contextWindow: 1_000_000, outputMax: 131_072 },
  { id: 'glm-5.1', displayName: 'GLM-5.1', observedAt: '2026-10-05', contextWindow: 200_000, outputMax: 131_072 },
  { id: 'glm-5', displayName: 'GLM-5', observedAt: '2026-10-05', contextWindow: 200_000, outputMax: 131_072 },
  { id: 'glm-4.7', displayName: 'GLM-4.7', observedAt: '2026-10-05', contextWindow: 200_000, outputMax: 131_072 },
  { id: 'glm-4.7-flashx', displayName: 'GLM-4.7-FlashX', observedAt: '2026-10-05', contextWindow: 200_000 },
  { id: 'glm-4.7-flash', displayName: 'GLM-4.7-Flash', observedAt: '2026-10-05', contextWindow: 200_000 },
  { id: 'glm-4.6', displayName: 'GLM-4.6', observedAt: '2026-10-05', contextWindow: 200_000, outputMax: 131_072 },
  { id: 'glm-4.5', displayName: 'GLM-4.5', observedAt: '2026-10-05', contextWindow: 128_000 },
  { id: 'glm-4.5-x', displayName: 'GLM-4.5-X', observedAt: '2026-10-05', contextWindow: 128_000 },
  { id: 'glm-4.5-air', displayName: 'GLM-4.5-Air', observedAt: '2026-10-05', contextWindow: 128_000 },
  { id: 'glm-4.5-airx', displayName: 'GLM-4.5-AirX', observedAt: '2026-10-05', contextWindow: 128_000 },
  { id: 'glm-4.5-flash', displayName: 'GLM-4.5-Flash', observedAt: '2026-10-05', contextWindow: 200_000 },
  { id: 'glm-4-32b-0414-128k', displayName: 'GLM-4-32B-0414-128K', observedAt: '2026-10-05', contextWindow: 128_000 },
]

export const GLM_STATIC_FLOOR_IDS: readonly string[] = ['glm-5.3', 'glm-5.3-flash', 'glm-5.2']

export function glmDisplayPin(id: string): GlmDisplayPin | undefined {
  const lower = id.trim().toLowerCase()
  return GLM_DISPLAY_PINS.find(pin => pin.id === lower)
}

export function glmDisplayName(id: string): string {
  const pin = glmDisplayPin(id)
  if (pin) return pin.displayName
  return id
    .trim()
    .toLowerCase()
    .split('-')
    .map((part, index) => (index === 0 ? part.toUpperCase() : part.charAt(0).toUpperCase() + part.slice(1)))
    .join('-')
}


export const GLM_PRICING_PAGE = 'https://docs.z.ai/guides/overview/pricing'

export interface GlmPricePin {
  id: string
  observedAt: string
  source: string
  costInPerMtok: number
  costOutPerMtok: number
  cachedInPerMtok?: number
}

export const GLM_PRICE_PINS: readonly GlmPricePin[] = [
  { id: 'glm-5.3', observedAt: '2026-10-05', source: GLM_PRICING_PAGE, costInPerMtok: 1.4, costOutPerMtok: 4.4, cachedInPerMtok: 0.26 },
  { id: 'glm-5.3-flash', observedAt: '2026-10-05', source: GLM_PRICING_PAGE, costInPerMtok: 0.15, costOutPerMtok: 0.5, cachedInPerMtok: 0.03 },
  { id: 'glm-5.3-flashx', observedAt: '2026-10-05', source: GLM_PRICING_PAGE, costInPerMtok: 0.37, costOutPerMtok: 1.25, cachedInPerMtok: 0.075 },
  { id: 'glm-5.2', observedAt: '2026-10-05', source: GLM_PRICING_PAGE, costInPerMtok: 1.4, costOutPerMtok: 4.4, cachedInPerMtok: 0.26 },
  { id: 'glm-5.1', observedAt: '2026-10-05', source: GLM_PRICING_PAGE, costInPerMtok: 1.4, costOutPerMtok: 4.4, cachedInPerMtok: 0.26 },
  { id: 'glm-5', observedAt: '2026-10-05', source: GLM_PRICING_PAGE, costInPerMtok: 1, costOutPerMtok: 3.2, cachedInPerMtok: 0.2 },
  { id: 'glm-4.7', observedAt: '2026-10-05', source: GLM_PRICING_PAGE, costInPerMtok: 0.6, costOutPerMtok: 2.2, cachedInPerMtok: 0.11 },
  { id: 'glm-4.7-flashx', observedAt: '2026-10-05', source: GLM_PRICING_PAGE, costInPerMtok: 0.07, costOutPerMtok: 0.4, cachedInPerMtok: 0.01 },
  { id: 'glm-4.7-flash', observedAt: '2026-10-05', source: GLM_PRICING_PAGE, costInPerMtok: 0, costOutPerMtok: 0, cachedInPerMtok: 0 },
  { id: 'glm-4.6', observedAt: '2026-10-05', source: GLM_PRICING_PAGE, costInPerMtok: 0.6, costOutPerMtok: 2.2, cachedInPerMtok: 0.11 },
  { id: 'glm-4.5', observedAt: '2026-10-05', source: GLM_PRICING_PAGE, costInPerMtok: 0.6, costOutPerMtok: 2.2, cachedInPerMtok: 0.11 },
  { id: 'glm-4.5-x', observedAt: '2026-10-05', source: GLM_PRICING_PAGE, costInPerMtok: 2.2, costOutPerMtok: 8.9, cachedInPerMtok: 0.45 },
  { id: 'glm-4.5-air', observedAt: '2026-10-05', source: GLM_PRICING_PAGE, costInPerMtok: 0.2, costOutPerMtok: 1.1, cachedInPerMtok: 0.03 },
  { id: 'glm-4.5-airx', observedAt: '2026-10-05', source: GLM_PRICING_PAGE, costInPerMtok: 1.1, costOutPerMtok: 4.5, cachedInPerMtok: 0.22 },
  { id: 'glm-4.5-flash', observedAt: '2026-10-05', source: GLM_PRICING_PAGE, costInPerMtok: 0, costOutPerMtok: 0, cachedInPerMtok: 0 },
  { id: 'glm-4-32b-0414-128k', observedAt: '2026-10-05', source: GLM_PRICING_PAGE, costInPerMtok: 0.1, costOutPerMtok: 0.1 },
]

export function glmPricePin(model: string): GlmPricePin | undefined {
  const lower = model.trim().toLowerCase()
  return GLM_PRICE_PINS.find(p => p.id === lower)
}
