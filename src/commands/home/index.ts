import type { Command } from '../../commands.js'

const home = {
  type: 'local-jsx',
  name: 'home',
  description: 'Show the Mercury home splash — sigil, identity, realm & fleet glance',
  isEnabled: () => true,
  load: () => import('./home.js'),
} satisfies Command

export default home
