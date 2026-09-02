import type { Command } from '../../commands.js'

const live = {
  type: 'local-jsx',
  name: 'live',
  needsConcourse: true,
  description:
    'Live token-burn awareness — agents working now + running swarm fan-outs (the Live view & Workflow monitor)',
  isEnabled: () => true,
  load: () => import('./live.js'),
} satisfies Command

export default live
