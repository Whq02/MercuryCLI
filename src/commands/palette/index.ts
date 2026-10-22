import type { Command } from '../../commands.js'

const palette = {
  type: 'local-jsx',
  name: 'palette',
  description:
    'Fuzzy command palette — search across all commands',
  aliases: ['p'],
  isEnabled: () => true,
  isHidden: false,
  load: () => import('./palette.js'),
} satisfies Command

export default palette
