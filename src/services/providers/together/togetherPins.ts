export const TOGETHER_OBSERVED_AT = '2026-10-17'
const TOGETHER_MODEL_PREFIX = 'together/'

type TogetherThinkingDial = 'toggle' | 'effort' | 'none'

interface TogetherDisplayPin {
  id: string
  observedAt?: string
  source?: string
  displayName: string
  contextWindow?: number
  costInPerMtok: number
  costOutPerMtok: number
  cachedInPerMtok?: number
  thinking: TogetherThinkingDial
  efforts?: readonly string[]
  images?: boolean
  free?: boolean
}

export const TOGETHER_DISPLAY_PINS: readonly TogetherDisplayPin[] = [
  { id: 'moonshotai/Kimi-K3', displayName: 'Kimi K3', contextWindow: 1_048_576, costInPerMtok: 3, cachedInPerMtok: 0.3, costOutPerMtok: 15, thinking: 'toggle', images: true },
  { id: 'zai-org/GLM-5.3', displayName: 'GLM 5.3', contextWindow: 1_048_575, costInPerMtok: 1.4, cachedInPerMtok: 0.26, costOutPerMtok: 4.4, thinking: 'toggle' },
  { id: 'zai-org/GLM-5.3-Flash', displayName: 'GLM 5.3 Flash', contextWindow: 1_048_575, costInPerMtok: 0.15, cachedInPerMtok: 0.03, costOutPerMtok: 0.5, thinking: 'none', images: true, observedAt: '2026-10-25', source: 'https://www.together.ai/pricing' },
  { id: 'zai-org/GLM-5.2', displayName: 'GLM 5.2', contextWindow: 1_048_575, costInPerMtok: 1.4, cachedInPerMtok: 0.26, costOutPerMtok: 4.4, thinking: 'toggle' },
  { id: 'deepseek-ai/DeepSeek-V4-Pro-0813', displayName: 'DeepSeek V4 Pro', contextWindow: 1_048_576, costInPerMtok: 1.32, cachedInPerMtok: 0.13, costOutPerMtok: 3.96, thinking: 'toggle', efforts: ['high', 'max'] },
  { id: 'deepseek-ai/DeepSeek-V4.1-Flash', displayName: 'DeepSeek V4.1 Flash', contextWindow: 1_000_000, costInPerMtok: 0.3, cachedInPerMtok: 0.006, costOutPerMtok: 1.2, thinking: 'none', images: true, observedAt: '2026-10-25', source: 'https://www.together.ai/pricing' },
  { id: 'Qwen/Qwen3.8-2.4T-A95B', displayName: 'Qwen3.8 2.4T', contextWindow: 1_000_000, costInPerMtok: 2, cachedInPerMtok: 0.25, costOutPerMtok: 6, thinking: 'none', images: true, observedAt: '2026-10-25', source: 'https://www.together.ai/pricing' },
  { id: 'Qwen/Qwen3.8-Flash', displayName: 'Qwen3.8 Flash', contextWindow: 1_000_000, costInPerMtok: 0.15, costOutPerMtok: 0.47, thinking: 'none', images: true, observedAt: '2026-10-25', source: 'https://www.together.ai/pricing' },
  { id: 'Qwen/Qwen3.7-Max', displayName: 'Qwen3.7 Max', costInPerMtok: 1.5, cachedInPerMtok: 0.3, costOutPerMtok: 4.5, thinking: 'none', observedAt: '2026-10-25', source: 'https://www.together.ai/pricing' },
  { id: 'Qwen/Qwen3.7-Plus', displayName: 'Qwen3.7 Plus', contextWindow: 1_000_000, costInPerMtok: 0.32, costOutPerMtok: 1.28, thinking: 'none', images: true, observedAt: '2026-10-25', source: 'https://www.together.ai/pricing' },
  { id: 'Qwen/Qwen3.6-Plus', displayName: 'Qwen3.6 Plus', contextWindow: 1_000_000, costInPerMtok: 0.5, costOutPerMtok: 3, thinking: 'toggle', images: true, observedAt: '2026-10-25', source: 'https://www.together.ai/pricing' },
  { id: 'MiniMaxAI/MiniMax-M3', displayName: 'MiniMax M3', contextWindow: 524_288, costInPerMtok: 0.3, cachedInPerMtok: 0.06, costOutPerMtok: 1.2, thinking: 'toggle', images: true },
  { id: 'meta-models/Muse-Spark-Open-816B-A42B', displayName: 'Muse Spark Open 816B', contextWindow: 1_048_576, costInPerMtok: 1.25, cachedInPerMtok: 0.15, costOutPerMtok: 4.25, thinking: 'none', images: true, observedAt: '2026-10-25', source: 'https://www.together.ai/pricing' },
  { id: 'meta-models/Muse-Glimmer-30B', displayName: 'Muse Glimmer 30B', contextWindow: 131_072, costInPerMtok: 0.35, cachedInPerMtok: 0.04, costOutPerMtok: 1.5, thinking: 'none', images: true, observedAt: '2026-10-25', source: 'https://www.together.ai/pricing' },
  { id: 'reflection/Beam-1.0-501B-A23B', displayName: 'Beam 1.0 501B', contextWindow: 1_048_576, costInPerMtok: 0.4, cachedInPerMtok: 0.04, costOutPerMtok: 1.2, thinking: 'none' },
  { id: 'thinkingmachines/Inkling', displayName: 'Inkling', contextWindow: 524_288, costInPerMtok: 1, cachedInPerMtok: 0.17, costOutPerMtok: 4.05, thinking: 'none', images: true, observedAt: '2026-10-25', source: 'https://www.together.ai/pricing' },
  { id: 'nvidia/NVIDIA-Nemotron-3.5-Super-VL', displayName: 'Nemotron 3.5 Super VL', contextWindow: 262_144, costInPerMtok: 0.15, cachedInPerMtok: 0.02, costOutPerMtok: 0.5, thinking: 'none', images: true },
  { id: 'openai/gpt-oss-120b', displayName: 'GPT-OSS 120B', contextWindow: 131_072, costInPerMtok: 0.15, costOutPerMtok: 0.6, thinking: 'effort', efforts: ['low', 'medium', 'high'] },
  { id: 'Prism-ML/Ternary-Bonsai-27B', displayName: 'Ternary Bonsai 27B (free)', contextWindow: 262_144, costInPerMtok: 0, costOutPerMtok: 0, thinking: 'none', free: true, images: true, observedAt: '2026-10-25', source: 'https://www.together.ai/pricing' },
  { id: 'MiniMaxAI/MiniMax-M3.1-Flash', displayName: 'MiniMax M3.1 Flash', observedAt: '2026-10-25', source: 'https://docs.together.ai/docs/serverless-models', contextWindow: 1_048_576, costInPerMtok: 0.15, cachedInPerMtok: 0.015, costOutPerMtok: 0.6, thinking: 'none', images: true },
  { id: 'deepseek-ai/DeepSeek-V4.1-Flash-1017', displayName: 'DeepSeek V4.1 Flash 1017', observedAt: '2026-10-25', source: 'https://docs.together.ai/docs/serverless-models', contextWindow: 1_000_000, costInPerMtok: 0.3, cachedInPerMtok: 0.006, costOutPerMtok: 1.2, thinking: 'none', images: true },
  { id: 'Qwen/Qwen3.5-9B', displayName: 'Qwen3.5 9B', observedAt: '2026-10-25', source: 'https://docs.together.ai/docs/serverless-models', contextWindow: 262_144, costInPerMtok: 0.17, costOutPerMtok: 0.25, thinking: 'toggle', images: true },
  { id: 'Qwen/Qwen3.5-397B-A17B', displayName: 'Qwen3.5 397B-A17B', observedAt: '2026-10-25', source: 'https://www.together.ai/pricing', costInPerMtok: 0.6, cachedInPerMtok: 0.35, costOutPerMtok: 3.6, thinking: 'none' },
  { id: 'together/Tev1-4B-experimental', displayName: 'Tev1 4B Experimental', observedAt: '2026-10-25', source: 'https://docs.together.ai/docs/serverless-models', contextWindow: 32_768, costInPerMtok: 0.042, costOutPerMtok: 0, thinking: 'none' },
]

const TOGETHER_HYBRID_THINKING_MODELS: ReadonlySet<string> = new Set(
  ['MiniMaxAI/MiniMax-M3', 'deepseek-ai/DeepSeek-V4-Pro-0813', 'zai-org/GLM-5.2', 'zai-org/GLM-5.3', 'moonshotai/Kimi-K3', 'Qwen/Qwen3.6-Plus', 'Qwen/Qwen3.5-9B'].map(id => id.toLowerCase()),
)

const ANNOTATION_RE = /\[(?:[0-9]+m|served)\]/gi

export function isTogetherModelId(model: string): boolean {
  return model.trim().toLowerCase().startsWith(TOGETHER_MODEL_PREFIX)
}

export function togetherWireId(model: string): string {
  const trimmed = model.trim().replace(ANNOTATION_RE, '')
  return trimmed.toLowerCase().startsWith(TOGETHER_MODEL_PREFIX) ? trimmed.slice(TOGETHER_MODEL_PREFIX.length) : trimmed
}

export function togetherQualifiedId(wireId: string): string {
  return `${TOGETHER_MODEL_PREFIX}${wireId.trim()}`
}

export function togetherDisplayPin(id: string): TogetherDisplayPin | undefined {
  const wire = togetherWireId(id).toLowerCase()
  return TOGETHER_DISPLAY_PINS.find(pin => pin.id.toLowerCase() === wire)
}

export function togetherDisplayName(id: string): string {
  return togetherDisplayPin(id)?.displayName ?? togetherWireId(id)
}

export function togetherThinkingDial(id: string): TogetherThinkingDial {
  const pin = togetherDisplayPin(id)
  if (pin) return pin.thinking
  return TOGETHER_HYBRID_THINKING_MODELS.has(togetherWireId(id).toLowerCase()) ? 'toggle' : 'none'
}

export function togetherEffortVocabulary(id: string): readonly string[] {
  return togetherDisplayPin(id)?.efforts ?? []
}
