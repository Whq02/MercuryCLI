
export function isKimiModelId(model: string): boolean {
  const m = model.trim().toLowerCase()
  return m === 'kimi' || m.startsWith('kimi-') || m.startsWith('moonshot-')
}

export const KIMI_EFFORT_MODELS: ReadonlySet<string> = new Set(['kimi-k3'])
export const KIMI_EFFORTS: ReadonlySet<string> = new Set(['low', 'high', 'max'])

export function kimiAcceptsEffort(model: string, effort: string): boolean {
  return KIMI_EFFORT_MODELS.has(model.trim().toLowerCase()) && KIMI_EFFORTS.has(effort)
}

export function kimiSupportsTemperature(model: string): boolean {
  return model.trim().toLowerCase().startsWith('moonshot-v1-')
}

export interface KimiDisplayPin {
  id: string
  displayName: string
  observedAt: string
  contextWindow?: number
  outputMax?: number
  costInPerMtok?: number
  costOutPerMtok?: number
  cachedInPerMtok?: number
}

export const KIMI_PRESERVED_THINKING_MODELS: ReadonlySet<string> = new Set([
  'kimi-k3',
  'kimi-k2.7-code',
  'kimi-k2.7-code-highspeed',
])

export const KIMI_DISPLAY_PINS: readonly KimiDisplayPin[] = [
  {
    id: 'kimi-k3',
    displayName: 'Kimi K3',
    observedAt: '2026-08-21',
    contextWindow: 1_048_576,
    outputMax: 1_048_576,
    costInPerMtok: 3,
    costOutPerMtok: 15,
    cachedInPerMtok: 0.3,
  },
  {
    id: 'kimi-k2.7-code',
    displayName: 'Kimi K2.7 Code',
    observedAt: '2026-08-21',
  },
  {
    id: 'kimi-k2.7-code-highspeed',
    displayName: 'Kimi K2.7 Code Highspeed',
    observedAt: '2026-08-21',
  },
  {
    id: 'kimi-k2.6',
    displayName: 'Kimi K2.6',
    observedAt: '2026-08-21',
  },
  {
    id: 'kimi-k2.5',
    displayName: 'Kimi K2.5',
    observedAt: '2026-08-21',
  },
]

export function kimiDisplayPin(id: string): KimiDisplayPin | undefined {
  const lower = id.trim().toLowerCase()
  return KIMI_DISPLAY_PINS.find(p => p.id === lower)
}

export function kimiDisplayName(id: string): string | undefined {
  const pin = kimiDisplayPin(id)
  if (pin) return pin.displayName
  if (!isKimiModelId(id)) return undefined
  const lower = id.trim().toLowerCase()
  return lower
    .split('-')
    .map(part => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ')
}
