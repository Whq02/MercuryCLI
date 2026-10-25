export const FIREWORKS_OBSERVED_AT = '2026-10-17'
const FIREWORKS_MODEL_PREFIX = 'fireworks/'
const EFFORTS = ['none', 'low', 'medium', 'high', 'xhigh', 'max'] as const

interface FireworksDisplayPin {
  id: string
  displayName: string
  observedAt?: string
  source?: string
  contextWindow?: number
  outputMax?: number
  costInPerMtok?: number
  costOutPerMtok?: number
  cachedInPerMtok?: number
  reasoning: 'parsed' | 'none'
  efforts: readonly string[]
  images: boolean
}

const base = { reasoning: 'parsed', efforts: EFFORTS, images: false } as const
export const FIREWORKS_DISPLAY_PINS: readonly FireworksDisplayPin[] = [
  { ...base, id: 'accounts/fireworks/models/kimi-k3', displayName: 'Kimi K3', contextWindow: 1_040_000, costInPerMtok: 3, cachedInPerMtok: 0.3, costOutPerMtok: 15 },
  { ...base, id: 'accounts/fireworks/models/ember-1', displayName: 'Ember-1', costInPerMtok: 3, cachedInPerMtok: 0.3, costOutPerMtok: 15 },
  { ...base, id: 'accounts/fireworks/models/glm-5p3', displayName: 'GLM 5.3', contextWindow: 1_000_000, costInPerMtok: 1.4, cachedInPerMtok: 0.26, costOutPerMtok: 4.4 },
  { ...base, id: 'accounts/fireworks/models/glm-5p3-flash', displayName: 'GLM 5.3 Flash', contextWindow: 1_000_000, costInPerMtok: 0.15, cachedInPerMtok: 0.03, costOutPerMtok: 0.5 },
  { ...base, id: 'accounts/fireworks/models/deepseek-v4p1-flash', displayName: 'DeepSeek V4.1 Flash', contextWindow: 1_000_000, costInPerMtok: 0.3, cachedInPerMtok: 0.006, costOutPerMtok: 1.2 },
  { ...base, id: 'accounts/fireworks/models/qwen3p8-max', displayName: 'Qwen 3.8 Max', contextWindow: 262_144, costInPerMtok: 2, cachedInPerMtok: 0.25, costOutPerMtok: 6 },
  { ...base, id: 'accounts/fireworks/models/minimax-m3p1-flash', displayName: 'MiniMax M3.1 Flash', observedAt: '2026-10-25', contextWindow: 1_040_000, efforts: ['low', 'medium', 'high', 'xhigh', 'max'], images: true },
  { ...base, id: 'accounts/fireworks/models/minimax-m3', displayName: 'MiniMax M3', contextWindow: 512_000, costInPerMtok: 0.3, cachedInPerMtok: 0.06, costOutPerMtok: 1.2 },
  { ...base, id: 'accounts/fireworks/models/gpt-oss-120b', displayName: 'GPT OSS 120B', contextWindow: 131_072, costInPerMtok: 0.15, cachedInPerMtok: 0.015, costOutPerMtok: 0.6, efforts: ['low', 'medium', 'high'] },
  { ...base, id: 'accounts/fireworks/models/nemotron-lightning-3p5-30b-a3b', displayName: 'Nemotron 3.5 Lightning 30B', contextWindow: 262_144, costInPerMtok: 0.05, cachedInPerMtok: 0.01, costOutPerMtok: 0.2 },
  { ...base, id: 'accounts/fireworks/models/nemotron-3-ultra-nvfp4', displayName: 'Nemotron 3 Ultra (preview)', contextWindow: 1_000_000, costInPerMtok: 0.6, cachedInPerMtok: 0.12, costOutPerMtok: 2.4 },
  { ...base, id: 'accounts/fireworks/routers/kimi-fast-latest', displayName: 'Kimi Fast (Fire Pass)', contextWindow: 1_040_000, observedAt: '2026-10-25', source: 'https://docs.fireworks.ai/firepass', outputMax: 131_072, images: true },
  { ...base, id: 'accounts/fireworks/models/muse-spark-open', displayName: 'Muse Spark Open', observedAt: '2026-10-25', source: 'https://docs.fireworks.ai/serverless/pricing', costInPerMtok: 1.25, cachedInPerMtok: 0.15, costOutPerMtok: 4.25 },
  { ...base, id: 'accounts/fireworks/models/deepseek-v4p1-flash-1017', displayName: 'DeepSeek V4.1 Flash 1017', observedAt: '2026-10-25', source: 'https://docs.fireworks.ai/serverless/pricing', costInPerMtok: 0.3, cachedInPerMtok: 0.006, costOutPerMtok: 1.2 },
]

export function isFireworksModelId(model: string): boolean {
  return model.trim().toLowerCase().startsWith(FIREWORKS_MODEL_PREFIX)
}

export function fireworksWireId(model: string): string {
  const trimmed = model.trim().replace(/\[(?:[0-9]+m|served)\]/gi, '')
  const inner = isFireworksModelId(trimmed) ? trimmed.slice(FIREWORKS_MODEL_PREFIX.length) : trimmed
  if (inner === '' || inner.includes('/')) return inner
  return `accounts/fireworks/${inner === 'kimi-fast-latest' ? 'routers' : 'models'}/${inner}`
}

export function fireworksQualifiedId(id: string): string {
  return `${FIREWORKS_MODEL_PREFIX}${fireworksWireId(id)}`
}

export function isFireworksTextModelId(model: string): boolean {
  const id = fireworksWireId(model)
  return /^accounts\/[a-z0-9][a-z0-9._-]*\/(?:models|routers)\/[a-z0-9][a-z0-9._-]*$/i.test(id)
    && !/(?:whisper|orpheus|tts|guard|embed|rerank|flux|stable-diffusion|sdxl|playai)/i.test(id)
}

export function fireworksDisplayPin(id: string): FireworksDisplayPin | undefined {
  const wire = fireworksWireId(id).toLowerCase()
  return FIREWORKS_DISPLAY_PINS.find(pin => pin.id === wire)
}

export function fireworksDisplayName(id: string): string {
  return fireworksDisplayPin(id)?.displayName ?? fireworksWireId(id)
}

export function fireworksEffortVocabulary(id: string): readonly string[] {
  const wire = fireworksWireId(id)
  if (/\/(?:gpt-oss-(?:20b|120b)|minimax-m2(?:[.-]|$))/i.test(wire)) return ['low', 'medium', 'high']
  return fireworksDisplayPin(id)?.efforts ?? []
}
