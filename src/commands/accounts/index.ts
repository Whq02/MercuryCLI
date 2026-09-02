import type { Command } from '../../commands.js'

const command = {
  type: 'local-jsx',
  name: 'accounts',
  description: 'Provider accounts — slots, identity, and re-auth by family',
  isEnabled: () => true,
  isHidden: false,
  load: () => import('./accounts.js'),
} satisfies Command

export default command
