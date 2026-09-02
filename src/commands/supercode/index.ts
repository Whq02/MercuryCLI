import type { Command } from '../../commands.js'

const command = {
  type: 'local-jsx',
  name: 'supercode',
  description: 'Supercode mode — max effort + standing dynamic-orchestration (session-only; an explicit /effort level clears it)',
  isEnabled: () => true,
  isHidden: false,
  load: () => import('./supercode.js'),
} satisfies Command

export default command
