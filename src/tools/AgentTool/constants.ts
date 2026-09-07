export const AGENT_TOOL_NAME = 'Agent'
export const VERIFICATION_AGENT_TYPE = 'mercury-verifier'

export const RETIRED_AGENT_TYPES: Readonly<Record<string, string>> = {
  'general-purpose': 'mercury-general',
  verification: 'mercury-verifier',
}

export const ONE_SHOT_BUILTIN_AGENT_TYPES: ReadonlySet<string> = new Set([
  'mercury-scout',
  'mercury-architect',
])
