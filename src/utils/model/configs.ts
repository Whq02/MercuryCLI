
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

const CONTEXT_ANNOTATION_RE = /\[(?:[0-9]+m|served)\]/gi

function familyWordOf(id: string): string | undefined {
  return /^claude-([a-z]+)-\d/.exec(id)?.[1]
}

const MIRROR_FAMILY_WORDS: Record<string, ModelFamily> = Object.fromEntries(
  (Object.values(ALL_MODEL_CONFIGS) as ModelConfig[]).flatMap((config): Array<[string, ModelFamily]> => {
    const word = familyWordOf(config.firstParty)
    const target = config.canonical === undefined ? undefined : familyWordOf(config.canonical)
    if (word === undefined || target === undefined || word === target || !(target in FAMILY_GENERATIONS)) return []
    return [[word, target as ModelFamily]]
  }),
)

const FIRST_PARTY_FAMILY_WORDS = [...Object.keys(FAMILY_GENERATIONS), ...Object.keys(MIRROR_FAMILY_WORDS)]

const FIRST_PARTY_GENERATION_RE = new RegExp(
  `(?:^|[^a-z0-9])(?:claude-)?(${FIRST_PARTY_FAMILY_WORDS.join('|')})-(\\d{1,2}(?:-\\d{1,2})*)(?=-\\d{8}(?!\\d)|$|[^\\d-]|-(?!\\d))`,
)

export const DECLARED_GENERATION_STEMS: ReadonlyMap<string, string> = new Map(
  (Object.values(ALL_MODEL_CONFIGS) as ModelConfig[]).flatMap((config): Array<[string, string]> => {
    const canonical = config.canonical ?? config.firstParty
    return [
      [config.firstParty, canonical],
      [canonical, canonical],
    ]
  }),
)

export interface FirstPartyGeneration {
  family: ModelFamily
  generation: string
  stem: string
}

export function parseFirstPartyGeneration(id: string): FirstPartyGeneration | null {
  const lowered = id.trim().toLowerCase().replace(CONTEXT_ANNOTATION_RE, '')
  if (lowered.includes('/')) return null
  const match = FIRST_PARTY_GENERATION_RE.exec(lowered)
  if (match === null) return null
  const word = match[1]!
  const family = (MIRROR_FAMILY_WORDS[word] ?? word) as ModelFamily
  const generation = match[2]!
  return { family, generation, stem: `claude-${family}-${generation}` }
}

export function familyHeadOf(id: string): ModelKey | null {
  const parsed = parseFirstPartyGeneration(id)
  if (parsed === null) return null
  if (DECLARED_GENERATION_STEMS.has(parsed.stem)) return null
  return newestGenerationKey(parsed.family)
}

export function familyDefaultsModel(id: string): string {
  const head = familyHeadOf(id)
  return head === null ? id : ALL_MODEL_CONFIGS[head].firstParty
}
