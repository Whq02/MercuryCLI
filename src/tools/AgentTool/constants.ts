export const AGENT_TOOL_NAME = 'Agent'
// The old wire name, still honored everywhere it may have been persisted:
// permission rules, hook matchers, resumed sessions.
export const LEGACY_AGENT_TOOL_NAME = 'Task'
export const VERIFICATION_AGENT_TYPE = 'verification'

// Fire-and-forget built-ins: they report once and no parent ever continues
// them over SendMessage, so their results drop the agentId/SendMessage/usage
// trailer — at Explore's call volume those ~135 characters add up.
export const ONE_SHOT_BUILTIN_AGENT_TYPES: ReadonlySet<string> = new Set([
  'Explore',
  'Plan',
])
