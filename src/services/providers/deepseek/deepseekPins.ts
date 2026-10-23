
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

export const DEEPSEEK_PRICING_SOURCE = 'https://api-docs.deepseek.com/quick_start/pricing/'
export const DEEPSEEK_PRICING_OBSERVED_AT = '2026-10-23'

const HOLIDAYS_2026: readonly [string, string][] = [
  ['01-01', '01-03'], ['02-15', '02-23'], ['04-04', '04-06'],
  ['05-01', '05-05'], ['06-19', '06-21'], ['09-25', '09-27'], ['10-01', '10-07'],
]

export function deepseekRatePeriod(startedAtMs: number): 'peak' | 'off-peak' | 'holiday-unknown' {
  const date = new Date(startedAtMs)
  if (!Number.isFinite(date.getTime())) return 'holiday-unknown'
  const day = date.getUTCDay()
  const hour = date.getUTCHours()
  if (day === 0 || day === 6 || !((hour >= 1 && hour < 4) || (hour >= 6 && hour < 10))) return 'off-peak'
  if (date.getUTCFullYear() !== 2026) return 'holiday-unknown'
  const monthDay = date.toISOString().slice(5, 10)
  return HOLIDAYS_2026.some(([start, end]) => monthDay >= start && monthDay <= end) ? 'off-peak' : 'peak'
}
