export const CEREBRAS_OBSERVED_AT = '2026-10-18'
const CEREBRAS_MODEL_PREFIX = 'cerebras/'

interface CerebrasDisplayPin {
  id: string
  displayName: string
  contextWindow: number
  outputMax: number
  costInPerMtok: number
  costOutPerMtok: number
  cachedInPerMtok: number
  reasoning: 'parsed' | 'none'
  efforts: readonly string[]
  images: boolean
}

const shared = { contextWindow: 131_072, outputMax: 40_960, reasoning: 'parsed' } as const
export const CEREBRAS_DISPLAY_PINS: readonly CerebrasDisplayPin[] = [
  { ...shared, id: 'gpt-oss-120b', displayName: 'GPT OSS 120B', costInPerMtok: 0.35, costOutPerMtok: 0.75, cachedInPerMtok: 0.35, efforts: ['low', 'medium', 'high'], images: false },
  { ...shared, id: 'qwen-3.8-27b', displayName: 'Qwen 3.8 27B', costInPerMtok: 0.99, costOutPerMtok: 1.49, cachedInPerMtok: 0.99, efforts: ['none', 'low', 'medium', 'high'], images: true },
]

export function isCerebrasModelId(model: string): boolean {
  return model.trim().toLowerCase().startsWith(CEREBRAS_MODEL_PREFIX)
}

export function cerebrasWireId(model: string): string {
  const trimmed = model.trim().replace(/\[(?:[0-9]+m|served)\]/gi, '')
  return isCerebrasModelId(trimmed) ? trimmed.slice(CEREBRAS_MODEL_PREFIX.length) : trimmed
}

export function cerebrasQualifiedId(id: string): string {
  return `${CEREBRAS_MODEL_PREFIX}${cerebrasWireId(id)}`
}

export function isCerebrasTextModelId(model: string): boolean {
  const id = cerebrasWireId(model)
  return /^[a-z0-9][a-z0-9._-]*$/i.test(id) && !/(?:embed|rerank|whisper|tts|guard)/i.test(id)
}

export function cerebrasDisplayPin(id: string): CerebrasDisplayPin | undefined {
  const wire = cerebrasWireId(id).toLowerCase()
  return CEREBRAS_DISPLAY_PINS.find(pin => pin.id === wire)
}

export function cerebrasDisplayName(id: string): string {
  return cerebrasDisplayPin(id)?.displayName ?? cerebrasWireId(id)
}

export function cerebrasEffortVocabulary(id: string): readonly string[] {
  const wire = cerebrasWireId(id).toLowerCase()
  if (wire === 'gemma-4-31b') return ['none', 'low', 'medium', 'high']
  return cerebrasDisplayPin(id)?.efforts ?? []
}
