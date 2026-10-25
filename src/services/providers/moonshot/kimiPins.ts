
export function isKimiModelId(model: string): boolean {
  const m = model.trim().toLowerCase()
  return m === 'kimi' || m.startsWith('kimi-') || m.startsWith('moonshot-')
}

export const KIMI_K3_MODELS: ReadonlySet<string> = new Set([
  'kimi-k3.1-pro',
  'kimi-k3.1-pro-highspeed',
  'kimi-k3',
  'k3.1-pro',
  'k3.1-pro-highspeed',
  'k3',
  'k3-256k',
])

export const KIMI_DYNAMIC_TOOL_MODELS: ReadonlySet<string> = new Set([...KIMI_K3_MODELS, 'kimi-for-coding'])

let liveDynamicToolSupport: ((model: string) => boolean | undefined) | null = null

export function bindKimiDynamicToolSupport(reader: ((model: string) => boolean | undefined) | null): void {
  liveDynamicToolSupport = reader
}

export function kimiSupportsDynamicToolLoading(model: string): boolean {
  const id = model.trim().toLowerCase()
  return liveDynamicToolSupport?.(id) ?? KIMI_DYNAMIC_TOOL_MODELS.has(id)
}

type KimiThinkingRule = 'always-on' | 'opt-in'

export interface KimiDisplayPin {
  id: string
  displayName: string
  observedAt: string
  source?: string
  contextWindow?: number
  outputMax?: number
  efforts?: readonly string[]
  defaultEffort?: string
  thinking?: KimiThinkingRule
  costInPerMtok?: number
  costOutPerMtok?: number
  cachedInPerMtok?: number
}

const K3_SERIES_EFFORTS: readonly string[] = ['low', 'high', 'max']
const KIMI_K3_1_PRO_QUICKSTART = 'https://platform.kimi.ai/docs/guide/kimi-k3-1-pro-quickstart'
const KIMI_CODE_MODELS_PAGE = 'https://www.kimi.com/code/docs/en/kimi-code/models.html'

export const KIMI_PLAN_PINS: readonly KimiDisplayPin[] = [
  {
    id: 'k3.1-pro',
    displayName: 'K3.1 Pro',
    observedAt: '2026-10-25',
    source: KIMI_CODE_MODELS_PAGE,
    contextWindow: 1_048_576,
    efforts: K3_SERIES_EFFORTS,
    defaultEffort: 'high',
    thinking: 'always-on',
  },
  {
    id: 'k3.1-pro-highspeed',
    displayName: 'K3.1 Pro Highspeed',
    observedAt: '2026-10-25',
    source: KIMI_CODE_MODELS_PAGE,
    contextWindow: 1_048_576,
    efforts: K3_SERIES_EFFORTS,
    defaultEffort: 'high',
    thinking: 'always-on',
  },
  {
    id: 'k3',
    displayName: 'K3',
    observedAt: '2026-09-25',
    contextWindow: 1_048_576,
    efforts: K3_SERIES_EFFORTS,
    defaultEffort: 'high',
    thinking: 'always-on',
  },
  {
    id: 'k3-256k',
    displayName: 'K3 256K',
    observedAt: '2026-09-25',
    contextWindow: 262_144,
    efforts: K3_SERIES_EFFORTS,
    defaultEffort: 'high',
    thinking: 'always-on',
  },
]

export const KIMI_DISPLAY_PINS: readonly KimiDisplayPin[] = [
  {
    id: 'kimi-k3',
    displayName: 'Kimi K3',
    observedAt: '2026-08-21',
    contextWindow: 1_048_576,
    outputMax: 1_048_576,
    efforts: K3_SERIES_EFFORTS,
    defaultEffort: 'max',
    thinking: 'always-on',
    costInPerMtok: 3,
    costOutPerMtok: 15,
    cachedInPerMtok: 0.3,
  },
  {
    id: 'kimi-k3.1-pro',
    displayName: 'Kimi K3.1 Pro',
    observedAt: '2026-10-25',
    source: KIMI_K3_1_PRO_QUICKSTART,
    contextWindow: 1_048_576,
    outputMax: 1_048_576,
    efforts: K3_SERIES_EFFORTS,
    defaultEffort: 'max',
    thinking: 'always-on',
  },
  {
    id: 'kimi-k3.1-pro-highspeed',
    displayName: 'Kimi K3.1 Pro Highspeed',
    observedAt: '2026-10-25',
    source: KIMI_K3_1_PRO_QUICKSTART,
    contextWindow: 1_048_576,
    outputMax: 1_048_576,
    efforts: K3_SERIES_EFFORTS,
    defaultEffort: 'max',
    thinking: 'always-on',
  },
  {
    id: 'kimi-k2.7-code',
    displayName: 'Kimi K2.7 Code',
    observedAt: '2026-08-21',
    thinking: 'always-on',
  },
  {
    id: 'kimi-k2.7-code-highspeed',
    displayName: 'Kimi K2.7 Code Highspeed',
    observedAt: '2026-08-21',
    thinking: 'always-on',
  },
  {
    id: 'kimi-k2.6',
    displayName: 'Kimi K2.6',
    observedAt: '2026-08-21',
    thinking: 'opt-in',
  },
]

const KIMI_PINS: readonly KimiDisplayPin[] = [...KIMI_PLAN_PINS, ...KIMI_DISPLAY_PINS]

export const KIMI_EFFORT_MODELS: ReadonlySet<string> = new Set(
  KIMI_PINS.filter(pin => (pin.efforts?.length ?? 0) > 0).map(pin => pin.id),
)
export const KIMI_EFFORTS: ReadonlySet<string> = new Set(KIMI_PINS.flatMap(pin => pin.efforts ?? []))

export function kimiEffortsFor(model: string): readonly string[] {
  return kimiDisplayPin(model)?.efforts ?? []
}

export function kimiDefaultEffort(model: string): string | undefined {
  return kimiDisplayPin(model)?.defaultEffort
}

export function kimiAcceptsEffort(model: string, effort: string): boolean {
  return kimiEffortsFor(model).includes(effort)
}

export const KIMI_PRESERVED_THINKING_MODELS: ReadonlySet<string> = new Set(
  KIMI_PINS.filter(pin => pin.thinking === 'always-on').map(pin => pin.id),
)

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
