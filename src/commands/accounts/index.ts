import type { Command } from '../../commands.js'

// /accounts — mounts the Mercury AccountView (design-system surface) in place of the base surface.
const command = {
  type: 'local-jsx',
  name: 'accounts',
  description: 'Provider accounts — slots, identity, and re-auth by family',
  isEnabled: () => true,
  isHidden: false,
  load: () => import('./accounts.js'),
} satisfies Command

export default command
