import type { Command } from '../../commands.js'

const manager = {
  type: 'local-jsx',
  immediate: true,
  name: 'surfaces',
  aliases: ['manager'],
  isEnabled: () => true,
  description: 'Surface index — arrow-navigate every discoverable surface, grouped; ↵ opens it',
  load: () => import('./manager.js'),
} satisfies Command

export default manager
