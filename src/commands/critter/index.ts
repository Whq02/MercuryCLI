import type { Command } from '../../commands.js'

const critter = {
  type: 'local-jsx',
  name: 'critter',
  isEnabled: () => true,
  description: 'Session theme — pick the critter accent (crab/octopus/jellyfish/clam)',
  load: () => import('./critter.js'),
} satisfies Command

export default critter
