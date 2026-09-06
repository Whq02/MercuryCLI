import type { Command } from '../../commands.js'

const command = {
  type: 'local-jsx',
  name: 'supercode',
  description: 'Supercode mode — max effort + proactive delegation where parallel agents help (session-only; an explicit /effort level clears it)',
  isEnabled: () => true,
  isHidden: false,
  load: () => import('./supercode.js'),
} satisfies Command

export default command
