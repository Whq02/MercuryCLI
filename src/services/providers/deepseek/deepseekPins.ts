
export function isDeepseekModelId(model: string): boolean {
  const m = model.trim().toLowerCase()
  return m === 'deepseek' || m.startsWith('deepseek-')
}

export const DEEPSEEK_EFFORTS: ReadonlySet<string> = new Set(['low', 'high', 'max'])

export const DEEPSEEK_RETIRED_ALIASES: ReadonlyMap<string, string> = new Map([['deepseek-v4-flash', 'deepseek-flash']])

export function deepseekRetiredAliasTarget(id: string): string | undefined {
  return DEEPSEEK_RETIRED_ALIASES.get(id.trim().toLowerCase())
}

export function deepseekCurrentModelId(id: string): string {
  return deepseekRetiredAliasTarget(id) ?? id
}

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
    observedAt: '2026-09-17',
    contextWindow: 1_000_000,
    outputMax: 393_216,
    costInPerMtok: 1.32,
    costOutPerMtok: 3.96,
    cachedInPerMtok: 0.044,
  },
  {
    id: 'deepseek-flash',
    displayName: 'DeepSeek V4.1 Flash',
    observedAt: '2026-09-17',
    contextWindow: 1_000_000,
    outputMax: 393_216,
    costInPerMtok: 0.3,
    costOutPerMtok: 1.2,
    cachedInPerMtok: 0.006,
  },
]

export function deepseekDisplayPin(id: string): DeepseekDisplayPin | undefined {
  const current = deepseekCurrentModelId(id.trim().toLowerCase())
  return DEEPSEEK_DISPLAY_PINS.find(p => p.id === current)
}

export function deepseekDisplayName(id: string): string {
  const pin = deepseekDisplayPin(id)
  if (pin) return pin.displayName
  return id
    .trim()
    .toLowerCase()
    .split('-')
    .map(part => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ')
}
