export const ZEN_OBSERVED_AT = '2026-10-09'
export const ZEN_MODEL_PREFIX = 'zen/'

export type ZenWireShape = 'chat' | 'responses'
export type ZenServedShape = ZenWireShape | 'anthropic' | 'google' | 'systemone'

export interface ZenDisplayPin {
  id: string
  displayName: string
  shape: ZenWireShape
  contextWindow: number
  outputMax: number
  costInPerMtok: number
  costOutPerMtok: number
  cachedInPerMtok?: number
  cacheWritePerMtok?: number
  longContextThreshold?: number
  longContext?: { costInPerMtok: number; costOutPerMtok: number; cachedInPerMtok?: number }
  efforts?: readonly string[]
  thinkingToggle?: boolean
  tools?: boolean
  images?: boolean
  free?: boolean
}

export const ZEN_DISPLAY_PINS: readonly ZenDisplayPin[] = [
  { id: 'gpt-6-astra', displayName: 'GPT 6 Astra', shape: 'responses', contextWindow: 1_050_000, outputMax: 128_000, costInPerMtok: 10, costOutPerMtok: 50, cachedInPerMtok: 1, cacheWritePerMtok: 12.5, longContextThreshold: 272_000, longContext: { costInPerMtok: 20, costOutPerMtok: 75, cachedInPerMtok: 2 }, efforts: ['low', 'medium', 'high', 'xhigh', 'max'], images: true },
  { id: 'gpt-6.1-sol', displayName: 'GPT 6.1 Sol', shape: 'responses', contextWindow: 1_050_000, outputMax: 128_000, costInPerMtok: 2, costOutPerMtok: 10, cachedInPerMtok: 0.1, cacheWritePerMtok: 2.5, longContextThreshold: 272_000, longContext: { costInPerMtok: 4, costOutPerMtok: 15, cachedInPerMtok: 0.2 }, efforts: ['low', 'medium', 'high', 'xhigh', 'max'], images: true },
  { id: 'gpt-6-sol', displayName: 'GPT 6 Sol', shape: 'responses', contextWindow: 1_050_000, outputMax: 128_000, costInPerMtok: 2, costOutPerMtok: 10, cachedInPerMtok: 0.2, cacheWritePerMtok: 2.5, longContextThreshold: 272_000, longContext: { costInPerMtok: 4, costOutPerMtok: 15, cachedInPerMtok: 0.4 }, efforts: ['none', 'low', 'medium', 'high', 'xhigh', 'max'], images: true },
  { id: 'gpt-6-luna', displayName: 'GPT 6 Luna', shape: 'responses', contextWindow: 1_050_000, outputMax: 128_000, costInPerMtok: 0.1, costOutPerMtok: 0.5, cachedInPerMtok: 0.01, cacheWritePerMtok: 0.125, longContextThreshold: 272_000, longContext: { costInPerMtok: 0.2, costOutPerMtok: 0.75, cachedInPerMtok: 0.02 }, efforts: ['none', 'low', 'medium', 'high', 'xhigh', 'max'], images: true },
  { id: 'gpt-5.6-sol', displayName: 'GPT 5.6 Sol', shape: 'responses', contextWindow: 1_050_000, outputMax: 128_000, costInPerMtok: 4, costOutPerMtok: 20, cachedInPerMtok: 0.4, cacheWritePerMtok: 5, longContextThreshold: 272_000, longContext: { costInPerMtok: 8, costOutPerMtok: 30, cachedInPerMtok: 0.8 }, efforts: ['none', 'low', 'medium', 'high', 'xhigh', 'max'], images: true },
  { id: 'gpt-5.6-terra', displayName: 'GPT 5.6 Terra', shape: 'responses', contextWindow: 1_050_000, outputMax: 128_000, costInPerMtok: 2, costOutPerMtok: 12, cachedInPerMtok: 0.2, cacheWritePerMtok: 2.5, longContextThreshold: 272_000, longContext: { costInPerMtok: 4, costOutPerMtok: 18, cachedInPerMtok: 0.4 }, efforts: ['none', 'low', 'medium', 'high', 'xhigh', 'max'], images: true },
  { id: 'gpt-5.6-luna', displayName: 'GPT 5.6 Luna', shape: 'responses', contextWindow: 1_050_000, outputMax: 128_000, costInPerMtok: 0.2, costOutPerMtok: 1.2, cachedInPerMtok: 0.02, cacheWritePerMtok: 0.25, longContextThreshold: 272_000, longContext: { costInPerMtok: 0.4, costOutPerMtok: 1.8, cachedInPerMtok: 0.04 }, efforts: ['none', 'low', 'medium', 'high', 'xhigh', 'max'], images: true },
  { id: 'gpt-5.5', displayName: 'GPT 5.5', shape: 'responses', contextWindow: 1_050_000, outputMax: 128_000, costInPerMtok: 5, costOutPerMtok: 30, cachedInPerMtok: 0.5, longContextThreshold: 272_000, longContext: { costInPerMtok: 10, costOutPerMtok: 45, cachedInPerMtok: 1 }, efforts: ['none', 'low', 'medium', 'high', 'xhigh'], images: true },
  { id: 'gpt-5.5-pro', displayName: 'GPT 5.5 Pro', shape: 'responses', contextWindow: 1_050_000, outputMax: 128_000, costInPerMtok: 30, costOutPerMtok: 180, cachedInPerMtok: 30, efforts: ['medium', 'high', 'xhigh'], images: true },
  { id: 'gpt-5.4', displayName: 'GPT 5.4', shape: 'responses', contextWindow: 1_050_000, outputMax: 128_000, costInPerMtok: 2.5, costOutPerMtok: 15, cachedInPerMtok: 0.25, longContextThreshold: 272_000, longContext: { costInPerMtok: 5, costOutPerMtok: 22.5, cachedInPerMtok: 0.5 }, efforts: ['none', 'low', 'medium', 'high', 'xhigh'], images: true },
  { id: 'gpt-5.4-pro', displayName: 'GPT 5.4 Pro', shape: 'responses', contextWindow: 1_050_000, outputMax: 128_000, costInPerMtok: 30, costOutPerMtok: 180, cachedInPerMtok: 30, efforts: ['medium', 'high', 'xhigh'], images: true },
  { id: 'gpt-5.4-mini', displayName: 'GPT 5.4 Mini', shape: 'responses', contextWindow: 400_000, outputMax: 128_000, costInPerMtok: 0.75, costOutPerMtok: 4.5, cachedInPerMtok: 0.075, efforts: ['none', 'low', 'medium', 'high', 'xhigh'], images: true },
  { id: 'gpt-5.4-nano', displayName: 'GPT 5.4 Nano', shape: 'responses', contextWindow: 400_000, outputMax: 128_000, costInPerMtok: 0.2, costOutPerMtok: 1.25, cachedInPerMtok: 0.02, efforts: ['none', 'low', 'medium', 'high', 'xhigh'], images: true },
  { id: 'gpt-5.3-codex-spark', displayName: 'GPT 5.3 Codex Spark', shape: 'responses', contextWindow: 128_000, outputMax: 128_000, costInPerMtok: 1.75, costOutPerMtok: 14, cachedInPerMtok: 0.175, efforts: ['low', 'medium', 'high', 'xhigh'] },
  { id: 'gpt-5.3-codex', displayName: 'GPT 5.3 Codex', shape: 'responses', contextWindow: 400_000, outputMax: 128_000, costInPerMtok: 1.75, costOutPerMtok: 14, cachedInPerMtok: 0.175, efforts: ['none', 'low', 'medium', 'high', 'xhigh'], images: true },
  { id: 'gpt-5.2', displayName: 'GPT 5.2', shape: 'responses', contextWindow: 400_000, outputMax: 128_000, costInPerMtok: 1.75, costOutPerMtok: 14, cachedInPerMtok: 0.175, efforts: ['none', 'low', 'medium', 'high', 'xhigh'], images: true },
  { id: 'gpt-5.2-codex', displayName: 'GPT 5.2 Codex', shape: 'responses', contextWindow: 400_000, outputMax: 128_000, costInPerMtok: 1.75, costOutPerMtok: 14, cachedInPerMtok: 0.175, efforts: ['low', 'medium', 'high', 'xhigh'], images: true },
  { id: 'gpt-5.1', displayName: 'GPT 5.1', shape: 'responses', contextWindow: 400_000, outputMax: 128_000, costInPerMtok: 1.07, costOutPerMtok: 8.5, cachedInPerMtok: 0.107, efforts: ['none', 'low', 'medium', 'high'], images: true },
  { id: 'gpt-5.1-codex-max', displayName: 'GPT 5.1 Codex Max', shape: 'responses', contextWindow: 400_000, outputMax: 128_000, costInPerMtok: 1.25, costOutPerMtok: 10, cachedInPerMtok: 0.125, efforts: ['low', 'medium', 'high', 'xhigh'], images: true },
  { id: 'gpt-5.1-codex', displayName: 'GPT 5.1 Codex', shape: 'responses', contextWindow: 400_000, outputMax: 128_000, costInPerMtok: 1.07, costOutPerMtok: 8.5, cachedInPerMtok: 0.107, efforts: ['low', 'medium', 'high'], images: true },
  { id: 'gpt-5.1-codex-mini', displayName: 'GPT 5.1 Codex Mini', shape: 'responses', contextWindow: 400_000, outputMax: 128_000, costInPerMtok: 0.25, costOutPerMtok: 2, cachedInPerMtok: 0.025, efforts: ['low', 'medium', 'high'], images: true },
  { id: 'gpt-5', displayName: 'GPT 5', shape: 'responses', contextWindow: 400_000, outputMax: 128_000, costInPerMtok: 1.07, costOutPerMtok: 8.5, cachedInPerMtok: 0.107, efforts: ['minimal', 'low', 'medium', 'high'], images: true },
  { id: 'gpt-5-codex', displayName: 'GPT 5 Codex', shape: 'responses', contextWindow: 400_000, outputMax: 128_000, costInPerMtok: 1.07, costOutPerMtok: 8.5, cachedInPerMtok: 0.107, efforts: ['low', 'medium', 'high'], images: true },
  { id: 'gpt-5-nano', displayName: 'GPT 5 Nano', shape: 'responses', contextWindow: 400_000, outputMax: 128_000, costInPerMtok: 0.05, costOutPerMtok: 0.4, cachedInPerMtok: 0.005, efforts: ['minimal', 'low', 'medium', 'high'], images: true },
  { id: 'grok-build-0.1', displayName: 'Grok Build 0.1', shape: 'responses', contextWindow: 256_000, outputMax: 256_000, costInPerMtok: 1, costOutPerMtok: 2, cachedInPerMtok: 0.2, images: true },
  { id: 'grok-4.7', displayName: 'Grok 4.7', shape: 'responses', contextWindow: 500_000, outputMax: 500_000, costInPerMtok: 2, costOutPerMtok: 6, cachedInPerMtok: 0.5, longContextThreshold: 200_000, longContext: { costInPerMtok: 4, costOutPerMtok: 12, cachedInPerMtok: 1 }, efforts: ['low', 'medium', 'high', 'xhigh'], images: true },
  { id: 'grok-4.6', displayName: 'Grok 4.6', shape: 'responses', contextWindow: 500_000, outputMax: 500_000, costInPerMtok: 2, costOutPerMtok: 6, cachedInPerMtok: 0.5, longContextThreshold: 200_000, longContext: { costInPerMtok: 4, costOutPerMtok: 12, cachedInPerMtok: 1 }, efforts: ['low', 'medium', 'high', 'xhigh'], images: true },
  { id: 'grok-4.5', displayName: 'Grok 4.5', shape: 'responses', contextWindow: 500_000, outputMax: 500_000, costInPerMtok: 2, costOutPerMtok: 6, cachedInPerMtok: 0.3, longContextThreshold: 200_000, longContext: { costInPerMtok: 4, costOutPerMtok: 12, cachedInPerMtok: 0.6 }, efforts: ['low', 'medium', 'high'], images: true },
  { id: 'muse-spark-1.3', displayName: 'Muse Spark 1.3', shape: 'responses', contextWindow: 1_048_576, outputMax: 131_072, costInPerMtok: 1.25, costOutPerMtok: 4.25, cachedInPerMtok: 0.15, efforts: ['minimal', 'low', 'medium', 'high', 'xhigh'], images: true },
  { id: 'muse-spark-1.2', displayName: 'Muse Spark 1.2', shape: 'responses', contextWindow: 1_048_576, outputMax: 131_072, costInPerMtok: 1.25, costOutPerMtok: 4.25, cachedInPerMtok: 0.15, efforts: ['minimal', 'low', 'medium', 'high', 'xhigh'], images: true },
  { id: 'mistral-large-4', displayName: 'Mistral Large 4', shape: 'chat', contextWindow: 524_288, outputMax: 262_144, costInPerMtok: 0.68, costOutPerMtok: 2.09, cachedInPerMtok: 0.07, efforts: ['none', 'high'], images: true },
  { id: 'deepseek-v4.1-flash', displayName: 'DeepSeek V4.1 Flash', shape: 'chat', contextWindow: 1_000_000, outputMax: 384_000, costInPerMtok: 0.3, costOutPerMtok: 1.2, cachedInPerMtok: 0.006, efforts: ['low', 'high', 'max'], images: true },
  { id: 'deepseek-v4-pro', displayName: 'DeepSeek V4 Pro', shape: 'chat', contextWindow: 1_000_000, outputMax: 384_000, costInPerMtok: 1.74, costOutPerMtok: 3.48, cachedInPerMtok: 0.145, efforts: ['high', 'max'], thinkingToggle: true },
  { id: 'deepseek-v4-flash', displayName: 'DeepSeek V4 Flash', shape: 'chat', contextWindow: 1_000_000, outputMax: 384_000, costInPerMtok: 0.14, costOutPerMtok: 0.28, cachedInPerMtok: 0.028, efforts: ['low', 'high', 'max'], thinkingToggle: true },
  { id: 'deepseek-v4-flash-vision-exp', displayName: 'DeepSeek V4 Flash Vision Exp', shape: 'chat', contextWindow: 1_000_000, outputMax: 384_000, costInPerMtok: 0.14, costOutPerMtok: 0.28, cachedInPerMtok: 0.028, efforts: ['low', 'high', 'max'], thinkingToggle: true, images: true },
  { id: 'glm-5.3-flash', displayName: 'GLM 5.3 Flash', shape: 'chat', contextWindow: 1_000_000, outputMax: 131_072, costInPerMtok: 0.15, costOutPerMtok: 0.5, cachedInPerMtok: 0.03, efforts: ['low', 'high', 'max'], images: true },
  { id: 'glm-5.3', displayName: 'GLM 5.3', shape: 'chat', contextWindow: 1_000_000, outputMax: 131_072, costInPerMtok: 1.4, costOutPerMtok: 4.4, cachedInPerMtok: 0.26, efforts: ['low', 'high', 'max'] },
  { id: 'glm-5.2', displayName: 'GLM 5.2', shape: 'chat', contextWindow: 1_000_000, outputMax: 131_072, costInPerMtok: 1.4, costOutPerMtok: 4.4, cachedInPerMtok: 0.26, efforts: ['high', 'max'] },
  { id: 'glm-5.1', displayName: 'GLM 5.1', shape: 'chat', contextWindow: 204_800, outputMax: 131_072, costInPerMtok: 1.4, costOutPerMtok: 4.4, cachedInPerMtok: 0.26, thinkingToggle: true },
  { id: 'glm-5', displayName: 'GLM 5', shape: 'chat', contextWindow: 204_800, outputMax: 131_072, costInPerMtok: 1, costOutPerMtok: 3.2, cachedInPerMtok: 0.2, thinkingToggle: true },
  { id: 'minimax-m3', displayName: 'MiniMax M3', shape: 'chat', contextWindow: 512_000, outputMax: 128_000, costInPerMtok: 0.3, costOutPerMtok: 1.2, cachedInPerMtok: 0.06, images: true },
  { id: 'minimax-m2.7', displayName: 'MiniMax M2.7', shape: 'chat', contextWindow: 204_800, outputMax: 131_072, costInPerMtok: 0.3, costOutPerMtok: 1.2, cachedInPerMtok: 0.06 },
  { id: 'minimax-m2.5', displayName: 'MiniMax M2.5', shape: 'chat', contextWindow: 204_800, outputMax: 131_072, costInPerMtok: 0.3, costOutPerMtok: 1.2, cachedInPerMtok: 0.06 },
  { id: 'kimi-k3', displayName: 'Kimi K3', shape: 'chat', contextWindow: 1_048_576, outputMax: 131_072, costInPerMtok: 3, costOutPerMtok: 15, cachedInPerMtok: 0.3, efforts: ['max'], images: true },
  { id: 'kimi-k2.7-code', displayName: 'Kimi K2.7 Code', shape: 'chat', contextWindow: 262_144, outputMax: 262_144, costInPerMtok: 0.95, costOutPerMtok: 4, cachedInPerMtok: 0.19, images: true },
  { id: 'kimi-k2.6', displayName: 'Kimi K2.6', shape: 'chat', contextWindow: 262_144, outputMax: 65_536, costInPerMtok: 0.95, costOutPerMtok: 4, cachedInPerMtok: 0.16, thinkingToggle: true, images: true },
  { id: 'kimi-k2.5', displayName: 'Kimi K2.5', shape: 'chat', contextWindow: 262_144, outputMax: 65_536, costInPerMtok: 0.6, costOutPerMtok: 3, cachedInPerMtok: 0.1, thinkingToggle: true, images: true },
  { id: 'qwen3.8-max', displayName: 'Qwen3.8 Max', shape: 'chat', contextWindow: 262_144, outputMax: 131_072, costInPerMtok: 2, costOutPerMtok: 6, cachedInPerMtok: 0.25, cacheWritePerMtok: 2.5, thinkingToggle: true, images: true },
  { id: 'big-pickle', displayName: 'Big Pickle', shape: 'chat', contextWindow: 200_000, outputMax: 32_000, costInPerMtok: 0, costOutPerMtok: 0, cachedInPerMtok: 0, free: true },
  { id: 'exo-free', displayName: 'Exo Free', shape: 'chat', contextWindow: 1_048_576, outputMax: 131_072, costInPerMtok: 0, costOutPerMtok: 0, cachedInPerMtok: 0, efforts: ['high'], images: true, free: true },
  { id: 'muse-spark-1.3-contributor-free', displayName: 'Muse Spark 1.3 Contributor Free', shape: 'responses', contextWindow: 1_048_576, outputMax: 131_072, costInPerMtok: 0, costOutPerMtok: 0, cachedInPerMtok: 0, efforts: ['minimal', 'low', 'medium', 'high', 'xhigh'], images: true, free: true },
  { id: 'muse-spark-1.2-contributor-free', displayName: 'Muse Spark 1.2 Contributor Free', shape: 'responses', contextWindow: 1_048_576, outputMax: 131_072, costInPerMtok: 0, costOutPerMtok: 0, cachedInPerMtok: 0, efforts: ['minimal', 'low', 'medium', 'high', 'xhigh'], images: true, free: true },
  { id: 'mimo-v2.6-flash-free', displayName: 'MiMo-V2.6-Flash Free', shape: 'chat', contextWindow: 200_000, outputMax: 32_000, costInPerMtok: 0, costOutPerMtok: 0, cachedInPerMtok: 0, images: true, free: true },
  { id: 'space-bunny-free', displayName: 'Space Bunny Free', shape: 'chat', contextWindow: 1_048_576, outputMax: 524_288, costInPerMtok: 0, costOutPerMtok: 0, cachedInPerMtok: 0, efforts: ['low', 'medium', 'high', 'xhigh', 'max'], images: true, free: true },
  { id: 'longcat-2.5-preview-free', displayName: 'LongCat 2.5 Preview Free', shape: 'chat', contextWindow: 1_000_000, outputMax: 131_072, costInPerMtok: 0, costOutPerMtok: 0, cachedInPerMtok: 0, thinkingToggle: true, images: true, free: true },
  { id: 'step-5-preview-free', displayName: 'Step 5 Preview Free', shape: 'chat', contextWindow: 1_000_000, outputMax: 65_536, costInPerMtok: 0, costOutPerMtok: 0, cachedInPerMtok: 0, efforts: ['low', 'medium', 'high'], images: true, free: true },
  { id: 'ling-3.0-flash-fin-free', displayName: 'Ling 3.0 Flash Fin Free', shape: 'chat', contextWindow: 262_144, outputMax: 32_768, costInPerMtok: 0, costOutPerMtok: 0, cachedInPerMtok: 0, thinkingToggle: true, free: true },
  { id: 'nemotron-3-ultra-free', displayName: 'Nemotron 3 Ultra Free', shape: 'chat', contextWindow: 1_000_000, outputMax: 128_000, costInPerMtok: 0, costOutPerMtok: 0, cachedInPerMtok: 0, free: true },
  { id: 'nemotron-3.5-lightning-free', displayName: 'Nemotron 3.5 Lightning Free', shape: 'chat', contextWindow: 262_144, outputMax: 262_144, costInPerMtok: 0, costOutPerMtok: 0, cachedInPerMtok: 0, free: true },
  { id: 'ling-3.1-flash-free', displayName: 'Ling 3.1 Flash Free', shape: 'chat', contextWindow: 262_144, outputMax: 32_768, costInPerMtok: 0, costOutPerMtok: 0, cachedInPerMtok: 0, thinkingToggle: true, free: true },
]

const ANNOTATION_RE = /\[(?:[0-9]+m|served)\]/gi

export function isZenModelId(model: string): boolean {
  return model.trim().toLowerCase().startsWith(ZEN_MODEL_PREFIX)
}

export function zenWireId(model: string): string {
  const trimmed = model.trim().replace(ANNOTATION_RE, '')
  return trimmed.toLowerCase().startsWith(ZEN_MODEL_PREFIX) ? trimmed.slice(ZEN_MODEL_PREFIX.length) : trimmed
}

export function zenQualifiedId(wireId: string): string {
  return `${ZEN_MODEL_PREFIX}${wireId.trim()}`
}

export function zenDisplayPin(id: string): ZenDisplayPin | undefined {
  const wire = zenWireId(id).toLowerCase()
  return ZEN_DISPLAY_PINS.find(pin => pin.id === wire)
}

export function zenDisplayName(id: string): string {
  return zenDisplayPin(id)?.displayName ?? zenWireId(id)
}

const ANTHROPIC_SHAPE_RE = /^(?:claude-|qwen3\.5-plus|qwen3\.6-plus|qwen3\.7-|qwen3\.8-flash)/i
const GOOGLE_SHAPE_RE = /^gemini-/i
const SYSTEMONE_SHAPE_RE = /^jev-/i
const RESPONSES_SHAPE_RE = /^(?:gpt-|grok-|muse-spark-)/i

export function zenServedShapeOf(id: string): ZenServedShape {
  const pin = zenDisplayPin(id)
  if (pin) return pin.shape
  const wire = zenWireId(id)
  if (ANTHROPIC_SHAPE_RE.test(wire)) return 'anthropic'
  if (GOOGLE_SHAPE_RE.test(wire)) return 'google'
  if (SYSTEMONE_SHAPE_RE.test(wire)) return 'systemone'
  if (RESPONSES_SHAPE_RE.test(wire)) return 'responses'
  return 'chat'
}

export function zenWireShapeOf(id: string): ZenWireShape | undefined {
  const shape = zenServedShapeOf(id)
  return shape === 'chat' || shape === 'responses' ? shape : undefined
}

export function zenAcceptsEffort(model: string, effort: string): boolean {
  return zenDisplayPin(model)?.efforts?.includes(effort) === true
}

export function zenIsFreeModel(id: string): boolean {
  return zenDisplayPin(id)?.free === true || /-free$/i.test(zenWireId(id)) || zenWireId(id).toLowerCase() === 'big-pickle'
}
