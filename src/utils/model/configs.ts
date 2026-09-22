
export type ModelConfig = {
  firstParty: string
  canonical?: string
}

export const ALL_MODEL_CONFIGS = {
  haiku35: {
    firstParty: 'claude-3-5-haiku-20241022',
    canonical: 'claude-3-5-haiku',
  },
  haiku45: {
    firstParty: 'claude-haiku-4-5-20251001',
    canonical: 'claude-haiku-4-5',
  },
  sonnet35: {
    firstParty: 'claude-3-5-sonnet-20241022',
    canonical: 'claude-3-5-sonnet',
  },
  sonnet37: {
    firstParty: 'claude-3-7-sonnet-20250219',
    canonical: 'claude-3-7-sonnet',
  },
  sonnet40: {
    firstParty: 'claude-sonnet-4-20250514',
    canonical: 'claude-sonnet-4',
  },
  sonnet45: {
    firstParty: 'claude-sonnet-4-5-20250929',
    canonical: 'claude-sonnet-4-5',
  },
  sonnet46: {
    firstParty: 'claude-sonnet-4-6',
  },
  sonnet5: {
    firstParty: 'claude-sonnet-5',
  },
  opus40: {
    firstParty: 'claude-opus-4-20250514',
    canonical: 'claude-opus-4',
  },
  opus41: {
    firstParty: 'claude-opus-4-1-20250805',
    canonical: 'claude-opus-4-1',
  },
  opus45: {
    firstParty: 'claude-opus-4-5-20251101',
    canonical: 'claude-opus-4-5',
  },
  opus46: {
    firstParty: 'claude-opus-4-6',
  },
  opus47: {
    firstParty: 'claude-opus-4-7',
    canonical: 'claude-opus-4-6',
  },
  opus48: {
    firstParty: 'claude-opus-4-8',
    canonical: 'claude-opus-4-6',
  },
  opus5: {
    firstParty: 'claude-opus-5',
  },
  opus55: {
    firstParty: 'claude-opus-5-5',
  },
  fable5: {
    firstParty: 'claude-fable-5',
  },
  fable51: {
    firstParty: 'claude-fable-5-1',
  },
  mythos5: {
    firstParty: 'claude-mythos-5',
    canonical: 'claude-fable-5',
  },
} as const satisfies Record<string, ModelConfig>

export type ModelKey = keyof typeof ALL_MODEL_CONFIGS

export const FAMILY_GENERATIONS = {
  fable: ['fable51', 'fable5'],
  opus: ['opus55', 'opus5', 'opus48', 'opus47', 'opus46'],
  sonnet: ['sonnet5', 'sonnet46'],
  haiku: ['haiku45'],
} as const satisfies Record<string, readonly ModelKey[]>

export type ModelFamily = keyof typeof FAMILY_GENERATIONS

export function newestGenerationKey(family: ModelFamily): ModelKey {
  return FAMILY_GENERATIONS[family][0]
}

export function previousGenerationKeys(family: ModelFamily): readonly ModelKey[] {
  return FAMILY_GENERATIONS[family].slice(1)
}

export type CanonicalModelId = (typeof ALL_MODEL_CONFIGS)[ModelKey]['firstParty']

export const CANONICAL_MODEL_IDS: CanonicalModelId[] = Object.values(ALL_MODEL_CONFIGS).map(
  config => config.firstParty,
)

export const CANONICAL_ID_TO_KEY: Record<string, ModelKey> = Object.fromEntries(
  (Object.entries(ALL_MODEL_CONFIGS) as Array<[ModelKey, ModelConfig]>).map(([key, config]) => [
    config.firstParty,
    key,
  ]),
) as Record<string, ModelKey>
