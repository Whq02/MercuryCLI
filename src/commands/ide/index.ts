import type { Command } from '../../commands.js'

const ide = {
  type: 'local-jsx',
  name: 'ide',
  description: 'Attach Mercury to your editor and inspect the IDE bridge',
  argumentHint: '[open]',
  load: () => import('./ide.js'),
} satisfies Command

export default ide
