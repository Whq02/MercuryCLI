import type { Command } from '../../commands.js'

export default {
  type: 'local-jsx',
  name: 'usage',
  description: 'Show usage per provider — every family, honest absence included',
  load: () => import('./usage.js'),
} satisfies Command
