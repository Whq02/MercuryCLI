import type { Command } from '../../commands.js'

const command = {
  type: 'local-jsx',
  name: 'agent-form',
  description: 'Create a new agent (alias of /agents → create)',
  isEnabled: () => true,
  isHidden: true,
  load: () => import('./agent-form.js'),
} satisfies Command

export default command
