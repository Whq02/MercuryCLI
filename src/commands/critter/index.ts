import type { Command } from '../../commands.js'

const critter = {
  type: 'local-jsx',
  name: 'critter',
  isEnabled: () => true,
  description: 'Choose the session critter',
  load: () => import('./critter.js'),
} satisfies Command

export default critter
