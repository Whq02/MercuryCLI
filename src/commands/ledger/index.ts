import type { Command } from '../../commands.js'


const command = {
  type: 'local-jsx',
  name: 'ledger',
  description: 'Evolution ledger — improvement programs, frontier + drift, across repo + memdir',
  isEnabled: () => true,
  isHidden: false,
  load: () => import('./ledger.js'),
} satisfies Command

export default command
