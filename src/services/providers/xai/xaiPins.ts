export const XAI_SURFACES_LANE_STUB = 'stub for the xai surfaces lane — replaced by the xai wire lane at the fold' as const
export function isXaiModelId(model: string): boolean {
  const m = model.trim().toLowerCase()
  return m === 'grok' || m.startsWith('grok-')
}

export const XAI_EFFORTS: ReadonlySet<string> = new Set<string>()

export const XAI_RETIRED_ALIASES: ReadonlyMap<string, string> = new Map<string, string>()

export function xaiRetiredAliasTarget(id: string): string | undefined {
  return XAI_RETIRED_ALIASES.get(id.trim().toLowerCase())
}

export function xaiCurrentModelId(id: string): string {
  return xaiRetiredAliasTarget(id) ?? id
}

export function xaiAcceptsEffort(model: string, effort: string): boolean {
  return isXaiModelId(model) && XAI_EFFORTS.has(effort)
}

export interface XaiDisplayPin {
  id: string
  displayName: string
  observedAt: string
  contextWindow?: number
  outputMax?: number
  costInPerMtok?: number
  costOutPerMtok?: number
  cachedInPerMtok?: number
}

export const XAI_DISPLAY_PINS: readonly XaiDisplayPin[] = []

export function xaiDisplayPin(id: string): XaiDisplayPin | undefined {
  const current = xaiCurrentModelId(id.trim().toLowerCase())
  return XAI_DISPLAY_PINS.find(p => p.id === current)
}

export function xaiDisplayName(id: string): string {
  const pin = xaiDisplayPin(id)
  if (pin) return pin.displayName
  return id
    .trim()
    .toLowerCase()
    .split('-')
    .map(part => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ')
}
