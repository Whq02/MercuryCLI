import type { Command } from '../../commands.js'

// /agent-form — thin alias: opens the Agent Studio (/agents) directly
// in create mode. The old state-only design specimen (AgentFormView) is absent;
// this name survives only as muscle-memory routing to the live product.
const command = {
  type: 'local-jsx',
  name: 'agent-form',
  description: 'Create a new agent (alias of /agents → create)',
  isEnabled: () => true,
  isHidden: true,
  load: () => import('./agent-form.js'),
} satisfies Command

export default command
