import type { Command } from '../../commands.js'

const substrate = {
  type: 'local-jsx',
  immediate: true,
  name: 'substrate',
  description:
    'Open the Mercury substrate control-panel — the substrate capabilities and their gates',
  isEnabled: () => true,
  load: () => import('./substrate.js'),
} satisfies Command

export default substrate
