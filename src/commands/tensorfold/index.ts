import type { Command } from '../../commands.js'
import { TENSORFOLD_WORDS } from './words.js'

export default {
  type: 'local-jsx',
  name: 'tensorfold',
  description: TENSORFOLD_WORDS.description,
  argumentHint: '[repository]',
  load: () => import('./tensorfold.js'),
} satisfies Command
