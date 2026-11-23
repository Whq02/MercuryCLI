import type { Command } from '../catalogue/commands.js'

const critter = {
  type: 'local-jsx',
  name: 'critter',
  isEnabled: () => true,
  description: 'Choose the session critter',
  load: () => import('./critter.js'),
} satisfies Command

export default critter
