export const HUGGINGFACE_MODEL_PREFIX = 'huggingface/'

export function isHuggingfaceModelId(model: string): boolean {
  return model.trim().toLowerCase().startsWith(HUGGINGFACE_MODEL_PREFIX)
}

export function splitHuggingfaceSlug(wireSlug: string): { hubId: string; suffix?: string } {
  const trimmed = wireSlug.trim()
  const colon = trimmed.lastIndexOf(':')

  if (colon === -1 || trimmed.indexOf('/', colon) !== -1) return { hubId: trimmed }
  const suffix = trimmed.slice(colon + 1)
  return suffix ? { hubId: trimmed.slice(0, colon), suffix } : { hubId: trimmed.slice(0, colon) }
}

export function huggingfaceSlugModelName(slug: string): string {
  const { hubId } = splitHuggingfaceSlug(slug.trim())
  const slash = hubId.lastIndexOf('/')
  return slash === -1 ? hubId : hubId.slice(slash + 1)
}

export const HUGGINGFACE_POLICY_SUFFIXES: ReadonlySet<string> = new Set(['fastest', 'cheapest', 'preferred'])

interface HuggingfaceDisplayPin {

  id: string
  displayName: string

  observedAt: string
  source?: string

  contextWindow?: number

  supportsTools: boolean

  priceFloorInPerMtok?: number
  priceFloorOutPerMtok?: number
}

export const HUGGINGFACE_DISPLAY_PINS: readonly HuggingfaceDisplayPin[] = [
  {
    id: 'deepseek-ai/DeepSeek-V4-Pro-0813',
    displayName: 'DeepSeek V4 Pro (0813)',
    observedAt: '2026-08-22',
    contextWindow: 1_048_576,
    supportsTools: true,
    priceFloorInPerMtok: 1.32,
    priceFloorOutPerMtok: 3.96,
  },
  {
    id: 'Qwen/Qwen3.8-2.4T-A95B',
    displayName: 'Qwen3.8 2.4T-A95B',
    observedAt: '2026-10-25',
    source: 'https://router.huggingface.co/v1/models',
    contextWindow: 1_000_000,
    supportsTools: true,
    priceFloorInPerMtok: 2,
    priceFloorOutPerMtok: 6.0,
  },
  {
    id: 'moonshotai/Kimi-K3',
    displayName: 'Kimi K3',
    observedAt: '2026-08-22',
    contextWindow: 1_048_576,
    supportsTools: true,
    priceFloorInPerMtok: 2.85,
    priceFloorOutPerMtok: 14.25,
  },
  {
    id: 'zai-org/GLM-5.2',
    displayName: 'GLM-5.2',
    observedAt: '2026-08-22',
    contextWindow: 1_048_576,
    supportsTools: true,
    priceFloorInPerMtok: 0.75,
    priceFloorOutPerMtok: 2.4,
  },
  {
    id: 'deepseek-ai/DeepSeek-V4-Flash-0731',
    displayName: 'DeepSeek V4 Flash (0731)',
    observedAt: '2026-10-25',
    source: 'https://router.huggingface.co/v1/models',
    contextWindow: 1_048_576,
    supportsTools: true,
    priceFloorInPerMtok: 0.06,
    priceFloorOutPerMtok: 0.18,
  },
  {
    id: 'MiniMaxAI/MiniMax-M3',
    displayName: 'MiniMax M3',
    observedAt: '2026-08-22',
    contextWindow: 1_000_000,
    supportsTools: true,
    priceFloorInPerMtok: 0.28,
    priceFloorOutPerMtok: 1.1,
  },
  {
    id: 'Qwen/Qwen3.5-397B-A17B',
    displayName: 'Qwen3.5 397B-A17B',
    observedAt: '2026-08-22',
    contextWindow: 262_144,
    supportsTools: true,
    priceFloorInPerMtok: 0.45,
    priceFloorOutPerMtok: 3,
  },
  {
    id: 'openai/gpt-oss-120b',
    displayName: 'gpt-oss 120B',
    observedAt: '2026-08-22',
    contextWindow: 131_072,
    supportsTools: true,
    priceFloorInPerMtok: 0.037,
    priceFloorOutPerMtok: 0.17,
  },
  {
    id: 'moonshotai/Kimi-K2.7-Code',
    displayName: 'Kimi K2.7 Code',
    observedAt: '2026-08-22',
    contextWindow: 262_144,
    supportsTools: true,
    priceFloorInPerMtok: 0.68,
    priceFloorOutPerMtok: 3.4,
  },
  {
    id: 'google/gemma-4-31B-it',
    displayName: 'Gemma 4 31B',
    observedAt: '2026-10-25',
    source: 'https://router.huggingface.co/v1/models',
    contextWindow: 262_144,
    supportsTools: true,
    priceFloorInPerMtok: 0.14,
    priceFloorOutPerMtok: 0.4,
  },
  { id: 'deepseek-ai/DeepSeek-V4-Pro', displayName: 'DeepSeek V4 Pro', observedAt: '2026-10-25', source: 'https://router.huggingface.co/v1/models', contextWindow: 1_048_576, supportsTools: true, priceFloorInPerMtok: 1.3, priceFloorOutPerMtok: 2.6 },
  { id: 'deepseek-ai/DeepSeek-V4.1-Flash-1017', displayName: 'DeepSeek V4.1 Flash 1017', observedAt: '2026-10-25', source: 'https://router.huggingface.co/v1/models', contextWindow: 1_048_576, supportsTools: true, priceFloorInPerMtok: 0.3, priceFloorOutPerMtok: 1.2 },
  { id: 'deepseek-ai/DeepSeek-V4.1-Flash', displayName: 'DeepSeek V4.1 Flash', observedAt: '2026-10-25', source: 'https://router.huggingface.co/v1/models', contextWindow: 1_048_576, supportsTools: true, priceFloorInPerMtok: 0.2, priceFloorOutPerMtok: 0.6 },
  { id: 'Qwen/Qwen3.8-27B', displayName: 'Qwen3.8 27B', observedAt: '2026-10-25', source: 'https://router.huggingface.co/v1/models', contextWindow: 1_000_000, supportsTools: true, priceFloorInPerMtok: 0.2, priceFloorOutPerMtok: 1.49 },
  { id: 'meta-models/Muse-Spark-Open-816B-A42B', displayName: 'Muse Spark Open 816B', observedAt: '2026-10-25', source: 'https://router.huggingface.co/v1/models', contextWindow: 1_048_576, supportsTools: true, priceFloorInPerMtok: 1.25, priceFloorOutPerMtok: 4.25 },
  { id: 'reflection/Beam-1.0-501B-A23B', displayName: 'Beam 1.0 501B', observedAt: '2026-10-25', source: 'https://router.huggingface.co/v1/models', contextWindow: 1_048_576, supportsTools: true, priceFloorInPerMtok: 0.4, priceFloorOutPerMtok: 1.2 },
  { id: 'nvidia/NVIDIA-Nemotron-3.5-Super-VL-120B-A12B-NVFP4', displayName: 'Nemotron 3.5 Super VL 120B', observedAt: '2026-10-25', source: 'https://router.huggingface.co/v1/models', contextWindow: 1_048_576, supportsTools: true, priceFloorInPerMtok: 0.2, priceFloorOutPerMtok: 0.5 },
  { id: 'zai-org/GLM-5.3-Flash', displayName: 'GLM-5.3-Flash', observedAt: '2026-10-25', source: 'https://router.huggingface.co/v1/models', contextWindow: 1_048_576, supportsTools: true, priceFloorInPerMtok: 0.15, priceFloorOutPerMtok: 0.5 },
  { id: 'zai-org/GLM-5.3', displayName: 'GLM-5.3', observedAt: '2026-10-25', source: 'https://router.huggingface.co/v1/models', contextWindow: 1_048_576, supportsTools: true, priceFloorInPerMtok: 0.9, priceFloorOutPerMtok: 4 },
]

export function huggingfaceDisplayPin(id: string): HuggingfaceDisplayPin | undefined {
  const raw = id.trim()
  const slug = isHuggingfaceModelId(raw) ? raw.slice(HUGGINGFACE_MODEL_PREFIX.length) : raw
  const { hubId } = splitHuggingfaceSlug(slug)
  const lower = hubId.toLowerCase()
  return HUGGINGFACE_DISPLAY_PINS.find(p => p.id.toLowerCase() === lower)
}
