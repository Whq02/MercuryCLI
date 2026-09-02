import type { Command } from '../../commands.js'

// global, route dispatch outcomes, memdir card decisions) but only one

const command = {
  type: 'local-jsx',
  name: 'ledger',
  description: 'Evolution ledger — improvement programs, frontier + drift, across repo + memdir',
  isEnabled: () => true,
  isHidden: false,
  load: () => import('./ledger.js'),
} satisfies Command

export default command
