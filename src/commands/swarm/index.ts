import type { Command } from '../../commands.js'

const swarm = {
  type: 'local-jsx',
  name: 'swarm',
  description: 'Crew chat — open the live timeline, or turn the board on or off',
  argumentHint: '[on|off]',
  headlessVerbs: ['', 'on', 'off'],
  load: () => import('./swarm.js'),
} satisfies Command

export default swarm
