
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

export const MODEL_FAMILY_ALIASES = ['sonnet', 'opus', 'haiku'] as const

export function isModelFamilyAlias(value: string): boolean {
  return (MODEL_FAMILY_ALIASES as readonly string[]).includes(value)
}
