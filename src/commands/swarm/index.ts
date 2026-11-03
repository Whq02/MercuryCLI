import type { Command } from '../../commands.js'

const swarm = {
  type: 'local-jsx',
  name: 'swarm',
  description: 'Crew chat — open the timeline or switch the board',
  argumentHint: '[on|off|status]',
  headlessVerbs: ['', 'on', 'off', 'status'],
  load: () => import('./swarm.js'),
} satisfies Command

export default swarm
