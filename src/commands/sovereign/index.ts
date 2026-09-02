import type { Command } from '../../commands.js'

const command = {
  type: 'local-jsx',
  name: 'sovereign',
  description: 'Sovereign posture — the permission-bypass indicator (read-only)',
  isEnabled: () => true,
  isHidden: false,
  load: () => import('../authority/sovereignPanel.js'),
} satisfies Command

export default command
