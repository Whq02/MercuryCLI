export const GROQ_OBSERVED_AT = '2026-10-18'
const GROQ_MODEL_PREFIX = 'groq/'

interface GroqDisplayPin {
  id: string
  displayName: string
  contextWindow: number
  outputMax: number
  costInPerMtok?: number
  costOutPerMtok?: number
  cachedInPerMtok?: number
  reasoning: 'included' | 'parsed' | 'none'
  efforts: readonly string[]
  images: boolean
}

const base = { contextWindow: 131_072, images: false } as const
const oss = { ...base, outputMax: 65_536, reasoning: 'included', efforts: ['low', 'medium', 'high'] } as const
export const GROQ_DISPLAY_PINS: readonly GroqDisplayPin[] = [
  { ...oss, id: 'openai/gpt-oss-120b', displayName: 'GPT OSS 120B', costInPerMtok: 0.15, costOutPerMtok: 0.6, cachedInPerMtok: 0.075 },
  { ...oss, id: 'openai/gpt-oss-20b', displayName: 'GPT OSS 20B', costInPerMtok: 0.075, costOutPerMtok: 0.3, cachedInPerMtok: 0.0375 },
  { ...base, id: 'qwen/qwen3.8-27b', displayName: 'Qwen 3.8 27B', outputMax: 16_384, reasoning: 'parsed', efforts: ['none', 'low', 'medium', 'high'], images: true, costInPerMtok: 0.8, costOutPerMtok: 4 },
  { ...base, id: 'minimaxai/minimax-m2.7', displayName: 'MiniMax M2.7', contextWindow: 196_608, outputMax: 131_072, reasoning: 'parsed', efforts: [] },
  { ...base, id: 'meta-models/muse-spark-open', displayName: 'Muse Spark Open', outputMax: 131_072, reasoning: 'parsed', efforts: ['low', 'medium', 'high', 'xhigh'], images: true },
  { ...base, id: 'llama-3.3-70b-versatile', displayName: 'Llama 3.3 70B', outputMax: 32_768, reasoning: 'none', efforts: [] },
  { ...base, id: 'llama-3.1-8b-instant', displayName: 'Llama 3.1 8B', outputMax: 131_072, reasoning: 'none', efforts: [] },
]

export function isGroqModelId(model: string): boolean {
  return model.trim().toLowerCase().startsWith(GROQ_MODEL_PREFIX)
}

export function groqWireId(model: string): string {
  const trimmed = model.trim().replace(/\[(?:[0-9]+m|served)\]/gi, '')
  return isGroqModelId(trimmed) ? trimmed.slice(GROQ_MODEL_PREFIX.length) : trimmed
}

export function groqQualifiedId(id: string): string {
  return `${GROQ_MODEL_PREFIX}${groqWireId(id)}`
}

export function isGroqTextModelId(model: string): boolean {
  const id = groqWireId(model)
  return /^[a-z0-9][a-z0-9._-]*(?:\/[a-z0-9][a-z0-9._-]*)?$/i.test(id)
    && !/(?:whisper|orpheus|playai-tts|prompt-guard|llama-guard|gpt-oss-safeguard)/i.test(id)
    && !/^canopylabs\//i.test(id)
}

export function groqDisplayPin(id: string): GroqDisplayPin | undefined {
  const wire = groqWireId(id).toLowerCase()
  return GROQ_DISPLAY_PINS.find(pin => pin.id === wire)
}

export function groqDisplayName(id: string): string {
  return groqDisplayPin(id)?.displayName ?? groqWireId(id)
}

export function groqEffortVocabulary(id: string): readonly string[] {
  return groqDisplayPin(id)?.efforts ?? []
}
