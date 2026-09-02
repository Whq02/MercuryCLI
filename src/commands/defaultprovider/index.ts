import type { Command } from '../../commands.js'

const defaultprovider = {
  type: 'local-jsx',
  name: 'defaultprovider',
  description: 'Show or switch the default provider — the lane fresh sessions start on',
  isEnabled: () => true,
  argumentHint: '[provider]',
  load: () => import('./defaultprovider.js'),
} satisfies Command

export default defaultprovider
