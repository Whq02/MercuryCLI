import type { Command } from '../../commands.js'

const substrate = {
  type: 'local-jsx',
  immediate: true,
  name: 'substrate',
  description:
    'Open the Mercury substrate control-panel — the substrate capabilities and their gates',
  // The panel reflects stamp-only gates, so
  // it is hidden without the stamp (mirrors /trace's stamp gate).
  isEnabled: () => true,
  load: () => import('./substrate.js'),
} satisfies Command

export default substrate
