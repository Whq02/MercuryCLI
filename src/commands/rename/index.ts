import type { Command } from '../catalogue/commands.js'

const rename: Command = {
  type: 'local-jsx',
  name: 'rename',
  description: 'Retitle this session',
  immediate: true,
  argumentHint: '[name]',
  load: () => import('./rename.js'),
}

export default rename
