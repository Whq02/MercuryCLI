
export function isKimiModelId(model: string): boolean {
  const m = model.trim().toLowerCase()
  return m === 'kimi' || m.startsWith('kimi-') || m.startsWith('moonshot-')
}

export const KIMI_K3_MODELS: ReadonlySet<string> = new Set(['kimi-k3', 'k3', 'k3-256k'])

export const KIMI_EFFORT_MODELS: ReadonlySet<string> = KIMI_K3_MODELS
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
  ...KIMI_K3_MODELS,
  'kimi-k2.7-code',
  'kimi-k2.7-code-highspeed',
])

export const KIMI_PLAN_PINS: readonly KimiDisplayPin[] = [
  {
    id: 'k3',
    displayName: 'K3',
    observedAt: '2026-09-25',
    contextWindow: 1_048_576,
  },
  {
    id: 'k3-256k',
    displayName: 'K3 256K',
    observedAt: '2026-09-25',
    contextWindow: 262_144,
  },
]

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

export function kimiPlanPin(id: string): KimiDisplayPin | undefined {
  const lower = id.trim().toLowerCase()
  return KIMI_PLAN_PINS.find(p => p.id === lower)
}

export function kimiDisplayPin(id: string): KimiDisplayPin | undefined {
  return kimiPlanPin(id) ?? KIMI_DISPLAY_PINS.find(p => p.id === id.trim().toLowerCase())
}

export function kimiMechanicalName(id: string): string {
  return id
    .trim()
    .toLowerCase()
    .split('-')
    .map(part => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ')
}

export function kimiDisplayName(id: string): string | undefined {
  const pin = kimiDisplayPin(id)
  if (pin) return pin.displayName
  if (!isKimiModelId(id)) return undefined
  return kimiMechanicalName(id)
}

export function kimiShortName(id: string): string | undefined {
  const name = kimiDisplayName(id)
  if (name === undefined) return undefined
  const short = name.replace(/^Kimi\s+/, '')
  return short === '' ? name : short
}
