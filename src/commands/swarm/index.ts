import type { Command } from '../../commands.js'

const swarm = {
  type: 'local',
  name: 'swarm',
  description: 'Live crew board for this session — on, off, or current state',
  argumentHint: '[on|off]',
  supportsNonInteractive: true,
  load: () => import('./swarm.js'),
} satisfies Command

export default swarm
