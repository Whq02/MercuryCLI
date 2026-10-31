import type { Command } from '../../commands.js'

const swarm = {
  type: 'local-jsx',
  name: 'swarm',
  description: 'Crew chat — open the timeline, switch the board, or lift and restore its limits',
  argumentHint: '[on|off|uncap|cap|status]',
  headlessVerbs: ['', 'on', 'off', 'uncap', 'cap', 'status'],
  load: () => import('./swarm.js'),
} satisfies Command

export default swarm
