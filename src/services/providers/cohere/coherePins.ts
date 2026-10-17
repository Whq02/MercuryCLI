export const COHERE_OBSERVED_AT = '2026-10-17'
export const COHERE_EFFORTS = ['none', 'high'] as const

export function isCohereModelId(model: string): boolean {
  const id = model.trim().toLowerCase()
  return id === 'cohere' || /^(?:command-|north-|c4ai-aya-)/.test(id)
}

export function isCohereChatModelId(model: string): boolean {
  const id = model.trim().toLowerCase()
  return /^(?:command-|north-|c4ai-aya-)/.test(id) && !/(?:embed|rerank|classify)/.test(id)
}

export interface CohereDisplayPin {
  id: string
  displayName: string
  observedAt: string
  contextWindow: number
  outputMax: number
  costInPerMtok?: number
  costOutPerMtok?: number
  tools: boolean
  images: boolean
  reasoning: boolean
  efforts: readonly string[]
}

const facts = { observedAt: COHERE_OBSERVED_AT, tools: true, images: false, reasoning: false, efforts: [] as readonly string[] } as const
const thinks = { reasoning: true, efforts: COHERE_EFFORTS } as const

export const COHERE_DISPLAY_PINS: readonly CohereDisplayPin[] = [
  { ...facts, ...thinks, id: 'command-a-plus-05-2026', displayName: 'Command A+', contextWindow: 128_000, outputMax: 64_000, images: true },
  { ...facts, ...thinks, id: 'north-mini-code-1-0', displayName: 'North Mini Code 1.0', contextWindow: 256_000, outputMax: 64_000 },
  { ...facts, ...thinks, id: 'command-a-reasoning-08-2025', displayName: 'Command A Reasoning', contextWindow: 256_000, outputMax: 32_000 },
  { ...facts, id: 'command-a-03-2025', displayName: 'Command A', contextWindow: 256_000, outputMax: 8_000, costInPerMtok: 2.5, costOutPerMtok: 10 },
  { ...facts, id: 'command-a-vision-07-2025', displayName: 'Command A Vision', contextWindow: 128_000, outputMax: 8_000, images: true },
  { ...facts, id: 'command-r-plus-08-2024', displayName: 'Command R+', contextWindow: 128_000, outputMax: 4_000, costInPerMtok: 2.5, costOutPerMtok: 10 },
  { ...facts, id: 'command-r-08-2024', displayName: 'Command R', contextWindow: 128_000, outputMax: 4_000, costInPerMtok: 0.15, costOutPerMtok: 0.6 },
  { ...facts, id: 'command-r7b-12-2024', displayName: 'Command R7B', contextWindow: 128_000, outputMax: 4_000 },
  { ...facts, id: 'c4ai-aya-expanse-32b', displayName: 'Aya Expanse 32B', contextWindow: 128_000, outputMax: 4_000, costInPerMtok: 0.5, costOutPerMtok: 1.5 },
]

function bareId(id: string): string {
  return id.trim().toLowerCase().replace(/\[(?:[0-9]+m|served)\]/gi, '')
}

export function cohereDisplayPin(id: string): CohereDisplayPin | undefined {
  const bare = bareId(id)
  return COHERE_DISPLAY_PINS.find(pin => pin.id === bare)
}

export function cohereDisplayName(id: string): string {
  return cohereDisplayPin(id)?.displayName ?? id
}

export function cohereAcceptsEffort(model: string, effort: string): boolean {
  return cohereDisplayPin(model)?.efforts.includes(effort) === true
}
