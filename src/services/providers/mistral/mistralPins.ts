export const MISTRAL_OBSERVED_AT = '2026-10-09'
export const MISTRAL_EFFORTS = ['none', 'high'] as const
export const MISTRAL_HOSTED_DEEPSEEK_IDS: readonly string[] = ['deepseek-v4-1-flash-1017']

export function isMistralModelId(model: string): boolean {
  const id = bareId(model)
  return id === 'mistral' || MISTRAL_HOSTED_DEEPSEEK_IDS.includes(id) || /^(?:mistral|ministral|codestral|zai-glm)-/.test(id)
}

export function isMistralChatModelId(model: string): boolean {
  const id = bareId(model)
  return (MISTRAL_HOSTED_DEEPSEEK_IDS.includes(id) || /^(?:mistral|ministral|codestral|zai-glm)-/.test(id)) && !/(?:embed|ocr|moderation|saba|transcribe|tts)/.test(id)
}

export interface MistralDisplayPin {
  id: string
  aliases: readonly string[]
  displayName: string
  observedAt: string
  source?: string
  contextWindow: number
  costInPerMtok: number
  cachedInPerMtok?: number
  costOutPerMtok: number
  tools: boolean
  structuredOutputs: boolean
  images: boolean
  reasoning: boolean
  efforts: readonly string[]
}

const facts = {
  observedAt: MISTRAL_OBSERVED_AT, contextWindow: 262_144,
  tools: true, structuredOutputs: true, images: true, reasoning: true, efforts: MISTRAL_EFFORTS,
} as const
const plain = { reasoning: false, efforts: [] as readonly string[] }

export const MISTRAL_DISPLAY_PINS: readonly MistralDisplayPin[] = [
  { ...facts, id: 'mistral-large-4', aliases: ['mistral-large-4-0'], displayName: 'Mistral Large 4 (Le Chonk, preview)', contextWindow: 1_048_576, efforts: ['low', 'medium', 'high'],
    observedAt: '2026-10-30', source: 'https://docs.mistral.ai/inference/pricing', costInPerMtok: 0.7, cachedInPerMtok: 0.07, costOutPerMtok: 2.1 },
  { ...facts, id: 'mistral-medium-3-5', aliases: ['mistral-medium-latest', 'mistral-medium-3'], displayName: 'Mistral Medium 3.5',
    observedAt: '2026-10-25', source: 'https://docs.mistral.ai/inference/pricing', costInPerMtok: 1.5, cachedInPerMtok: 0.15, costOutPerMtok: 7.5 },
  { ...facts, id: 'mistral-small-2603', aliases: ['mistral-small-latest'], displayName: 'Mistral Small 4',
    observedAt: '2026-10-25', source: 'https://docs.mistral.ai/inference/pricing', costInPerMtok: 0.15, cachedInPerMtok: 0.015, costOutPerMtok: 0.6 },
  { ...facts, ...plain, id: 'mistral-large-2512', aliases: ['mistral-large-latest'], displayName: 'Mistral Large 3',
    observedAt: '2026-10-25', source: 'https://docs.mistral.ai/inference/pricing', costInPerMtok: 0.5, cachedInPerMtok: 0.05, costOutPerMtok: 1.5 },
  { ...facts, ...plain, id: 'ministral-14b-2512', aliases: ['ministral-14b-latest'], displayName: 'Ministral 3 14B',
    observedAt: '2026-10-25', source: 'https://docs.mistral.ai/inference/pricing', costInPerMtok: 0.2, cachedInPerMtok: 0.02, costOutPerMtok: 0.2 },
  { ...facts, ...plain, id: 'ministral-8b-2512', aliases: ['ministral-8b-latest'], displayName: 'Ministral 3 8B',
    observedAt: '2026-10-25', source: 'https://docs.mistral.ai/inference/pricing', costInPerMtok: 0.15, cachedInPerMtok: 0.015, costOutPerMtok: 0.15 },
  { ...facts, ...plain, id: 'ministral-3b-2512', aliases: ['ministral-3b-latest'], displayName: 'Ministral 3 3B',
    observedAt: '2026-10-25', source: 'https://docs.mistral.ai/inference/pricing', costInPerMtok: 0.1, cachedInPerMtok: 0.01, costOutPerMtok: 0.1 },
  { ...facts, ...plain, id: 'codestral-2508', aliases: ['codestral-latest'], displayName: 'Codestral', contextWindow: 131_072, images: false,
    observedAt: '2026-10-25', source: 'https://docs.mistral.ai/inference/pricing', costInPerMtok: 0.3, cachedInPerMtok: 0.03, costOutPerMtok: 0.9 },
  { ...facts, id: 'zai-glm-5-3', aliases: [], displayName: 'Z.ai GLM 5.3', observedAt: '2026-10-25', source: 'https://docs.mistral.ai/models/zai-glm-5-3', contextWindow: 1_000_000, images: false, efforts: ['low', 'high', 'max'], costInPerMtok: 1.4, cachedInPerMtok: 0.14, costOutPerMtok: 4.4 },
  { ...facts, id: 'zai-glm-5-3-flash', aliases: [], displayName: 'Z.ai GLM 5.3 Flash', observedAt: '2026-10-25', source: 'https://docs.mistral.ai/models/zai-glm-5-3-flash', contextWindow: 1_000_000, efforts: [], costInPerMtok: 0.15, cachedInPerMtok: 0.03, costOutPerMtok: 0.5 },
  { ...facts, id: MISTRAL_HOSTED_DEEPSEEK_IDS[0]!, aliases: [], displayName: 'DeepSeek V4.1 Flash 1017', observedAt: '2026-10-30', source: 'https://docs.mistral.ai/models/deepseek-v4-flash-1017', contextWindow: 1_000_000, images: false, efforts: [], costInPerMtok: 0.3, cachedInPerMtok: 0.007, costOutPerMtok: 1.2 },
]

function bareId(id: string): string {
  return id.trim().toLowerCase().replace(/\[(?:[0-9]+m|served)\]/gi, '')
}

export function mistralDisplayPin(id: string): MistralDisplayPin | undefined {
  const bare = bareId(id)
  return MISTRAL_DISPLAY_PINS.find(pin => pin.id === bare || pin.aliases.includes(bare))
}

export function mistralDisplayName(id: string): string {
  return mistralDisplayPin(id)?.displayName ?? id
}

export function mistralAcceptsEffort(model: string, effort: string): boolean {
  return mistralDisplayPin(model)?.efforts.includes(effort) === true
}
