/**
 * The per-model provider-ID table (contract data — these exact strings are
 * what the provider API accepts) and its derived maps.
 *
 * Copy discipline: the table is DATA and must be carried verbatim, never
 * regenerated from a pattern.
 */

export type ModelConfig = {
  firstParty: string
}

export const ALL_MODEL_CONFIGS = {
  haiku35: {
    firstParty: 'claude-3-5-haiku-20241022',
  },
  haiku45: {
    firstParty: 'claude-haiku-4-5-20251001',
  },
  sonnet35: {
    firstParty: 'claude-3-5-sonnet-20241022',
  },
  sonnet37: {
    firstParty: 'claude-3-7-sonnet-20250219',
  },
  sonnet40: {
    firstParty: 'claude-sonnet-4-20250514',
  },
  sonnet45: {
    firstParty: 'claude-sonnet-4-5-20250929',
  },
  sonnet46: {
    firstParty: 'claude-sonnet-4-6',
  },
  sonnet5: {
    firstParty: 'claude-sonnet-5',
  },
  opus40: {
    firstParty: 'claude-opus-4-20250514',
  },
  opus41: {
    firstParty: 'claude-opus-4-1-20250805',
  },
  opus45: {
    firstParty: 'claude-opus-4-5-20251101',
  },
  opus46: {
    firstParty: 'claude-opus-4-6',
  },
  opus47: {
    firstParty: 'claude-opus-4-7',
  },
  opus48: {
    firstParty: 'claude-opus-4-8',
  },
  opus5: {
    firstParty: 'claude-opus-5',
  },
  fable5: {
    firstParty: 'claude-fable-5',
  },
  fable51: {
    firstParty: 'claude-fable-5-1',
  },
  mythos5: {
    firstParty: 'claude-mythos-5',
  },
} as const satisfies Record<string, ModelConfig>

export type ModelKey = keyof typeof ALL_MODEL_CONFIGS

/** The canonical (first-party) model-ID union and its runtime list. */
export type CanonicalModelId = (typeof ALL_MODEL_CONFIGS)[ModelKey]['firstParty']

export const CANONICAL_MODEL_IDS: CanonicalModelId[] = Object.values(ALL_MODEL_CONFIGS).map(
  config => config.firstParty,
)

/** Canonical first-party ID → table key (settings overrides are keyed on it). */
export const CANONICAL_ID_TO_KEY: Record<string, ModelKey> = Object.fromEntries(
  (Object.entries(ALL_MODEL_CONFIGS) as Array<[ModelKey, ModelConfig]>).map(([key, config]) => [
    config.firstParty,
    key,
  ]),
) as Record<string, ModelKey>
