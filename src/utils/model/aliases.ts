/**
 * Model alias vocabularies (contract data — user-facing setting spellings).
 *
 * Three distinct lists that must not be conflated:
 *  - the FULL alias list (settings/frontmatter validation),
 *  - the narrower dispatch list the subagent tool advertises and accepts
 *    (the single source for its schema, the agent model picker and help),
 *  - the bare family aliases that act as wildcards in the model allowlist.
 */

export const MODEL_ALIASES = [
  'sonnet',
  'opus',
  'haiku',
  'fable',
  'fable51',
  'mythos',
  'best',
  'sonnet[1m]',
  'opus[1m]',
  'fable[1m]',
  'opusplan',
] as const

export type ModelAlias = (typeof MODEL_ALIASES)[number]

export function isModelAlias(value: string): value is ModelAlias {
  return (MODEL_ALIASES as readonly string[]).includes(value)
}

/** The subagent-dispatch vocabulary — deliberately excludes the small/fast
 *  family, `best` and the plan alias. */
export const AGENT_DISPATCH_MODELS = [
  'sonnet',
  'opus',
  'fable',
  'fable51',
  'sonnet[1m]',
  'opus[1m]',
  'fable[1m]',
] as const

export type AgentDispatchModel = (typeof AGENT_DISPATCH_MODELS)[number]

/** Bare family aliases acting as wildcards in the model allowlist. */
export const MODEL_FAMILY_ALIASES = ['sonnet', 'opus', 'haiku'] as const

export function isModelFamilyAlias(value: string): boolean {
  return (MODEL_FAMILY_ALIASES as readonly string[]).includes(value)
}
