export function isXaiModelId(model: string): boolean {
  const id = model.trim().toLowerCase()
  return id === 'grok' || id.startsWith('grok-')
}

export const XAI_EFFORTS: ReadonlySet<string> = new Set(['none', 'low', 'medium', 'high', 'xhigh'])
export const XAI_RETIRED_ALIASES: ReadonlyMap<string, string> = new Map()
export function xaiRetiredAliasTarget(id: string): string | undefined {
  return XAI_RETIRED_ALIASES.get(id.trim().toLowerCase())
}
export function xaiCurrentModelId(id: string): string {
  return xaiRetiredAliasTarget(id) ?? id
}
export function xaiAcceptsEffort(model: string, effort: string): boolean {
  return xaiDisplayPin(model)?.efforts?.includes(effort) === true
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
  longContextThreshold?: number
  longContext?: { costInPerMtok: number; costOutPerMtok: number; cachedInPerMtok: number }
  tools?: boolean
  structuredOutputs?: boolean
  temperature?: boolean
  reasoning?: boolean
  images?: boolean
  efforts?: readonly string[]
  defaultEffort?: string
}

const facts = {
  observedAt: '2026-09-30', tools: true, structuredOutputs: true,
  temperature: true, images: true, longContextThreshold: 200_000,
} as const

export const XAI_DISPLAY_PINS: readonly XaiDisplayPin[] = [
  { ...facts, id: 'grok-4.7', displayName: 'Grok 4.7', contextWindow: 500_000,
    reasoning: true, efforts: ['low', 'medium', 'high', 'xhigh'], defaultEffort: 'high',
    costInPerMtok: 2, cachedInPerMtok: 0.5, costOutPerMtok: 6,
    longContext: { costInPerMtok: 4, cachedInPerMtok: 1, costOutPerMtok: 12 } },
  { ...facts, id: 'grok-4.6', displayName: 'Grok 4.6', contextWindow: 500_000,
    reasoning: true, efforts: ['low', 'medium', 'high', 'xhigh'], defaultEffort: 'high',
    costInPerMtok: 2, cachedInPerMtok: 0.5, costOutPerMtok: 6,
    longContext: { costInPerMtok: 4, cachedInPerMtok: 1, costOutPerMtok: 12 } },
  { ...facts, id: 'grok-4.5', displayName: 'Grok 4.5', contextWindow: 500_000,
    reasoning: true, efforts: ['low', 'medium', 'high'], defaultEffort: 'high',
    costInPerMtok: 2, cachedInPerMtok: 0.3, costOutPerMtok: 6,
    longContext: { costInPerMtok: 4, cachedInPerMtok: 0.6, costOutPerMtok: 12 } },
  { ...facts, id: 'grok-4.3', displayName: 'Grok 4.3', contextWindow: 1_000_000,
    reasoning: true, efforts: ['none', 'low', 'medium', 'high', 'xhigh'], defaultEffort: 'low',
    costInPerMtok: 1.25, cachedInPerMtok: 0.2, costOutPerMtok: 2.5,
    longContext: { costInPerMtok: 2.5, cachedInPerMtok: 0.4, costOutPerMtok: 5 } },
  { ...facts, id: 'grok-4.20-0309-reasoning', displayName: 'Grok 4.20', contextWindow: 1_000_000,
    reasoning: true, costInPerMtok: 1.25, cachedInPerMtok: 0.2, costOutPerMtok: 2.5,
    longContext: { costInPerMtok: 2.5, cachedInPerMtok: 0.4, costOutPerMtok: 5 } },
  { ...facts, id: 'grok-4.20-0309-non-reasoning', displayName: 'Grok 4.20 (Non-Reasoning)', contextWindow: 1_000_000,
    reasoning: false, efforts: [], costInPerMtok: 1.25, cachedInPerMtok: 0.2, costOutPerMtok: 2.5,
    longContext: { costInPerMtok: 2.5, cachedInPerMtok: 0.4, costOutPerMtok: 5 } },
  { ...facts, id: 'grok-build-0.1', displayName: 'Grok Build 0.1', contextWindow: 256_000,
    reasoning: true, costInPerMtok: 1, cachedInPerMtok: 0.2, costOutPerMtok: 2,
    longContext: { costInPerMtok: 2, cachedInPerMtok: 0.4, costOutPerMtok: 4 } },
]

export function xaiDisplayPin(id: string): XaiDisplayPin | undefined {
  return XAI_DISPLAY_PINS.find(pin => pin.id === xaiCurrentModelId(id.trim().toLowerCase()))
}
export function xaiDisplayName(id: string): string {
  return xaiDisplayPin(id)?.displayName ?? id
}

export function isXaiChatModelId(id: string): boolean {
  return /^grok-/i.test(id) && !/(?:imagine|image|video|voice|audio|multi-agent)/i.test(id)
}
