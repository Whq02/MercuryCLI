import type { Command } from '../../commands.js'

const monitor = {
  type: 'local-jsx',
  immediate: true,
  name: 'monitor',
  needsConcourse: true,
  description:
    'Fullscreen navigable fleet monitor — missions, agents, leases (master-detail, drill-in)',
  isEnabled: () => true,
  load: () => import('./monitor.js'),
} satisfies Command

export default monitor
