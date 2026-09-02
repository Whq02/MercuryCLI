import type { Command } from '../../commands.js'

const palette = {
  type: 'local-jsx',
  name: 'palette',
  description:
    'Fuzzy command palette — nucleo-style search over the live command roster + the command ladder',
  aliases: ['p'],
  isEnabled: () => true,
  isHidden: false,
  load: () => import('./palette.js'),
} satisfies Command

export default palette
