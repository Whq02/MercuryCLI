import type { Command } from '../../commands.js'

// /critter — the session-theme picker (critter accent re-tints identity).
const critter = {
  type: 'local-jsx',
  name: 'critter',
  // Mercury-only surface — hidden on a bare-stamp build.
  isEnabled: () => true,
  description: 'Session theme — pick the critter accent (crab/octopus/jellyfish/clam)',
  load: () => import('./critter.js'),
} satisfies Command

export default critter
