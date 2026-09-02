
export function isDeepseekModelId(model: string): boolean {
  const m = model.trim().toLowerCase()
  return m === 'deepseek' || m.startsWith('deepseek-')
}

export const DEEPSEEK_EFFORTS: ReadonlySet<string> = new Set(['low', 'high', 'max'])

export function deepseekAcceptsEffort(model: string, effort: string): boolean {
  return isDeepseekModelId(model) && DEEPSEEK_EFFORTS.has(effort)
}

export interface DeepseekDisplayPin {
  id: string
  displayName: string
  observedAt: string
  contextWindow?: number
  outputMax?: number
  costInPerMtok?: number
  costOutPerMtok?: number
  cachedInPerMtok?: number
}

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
