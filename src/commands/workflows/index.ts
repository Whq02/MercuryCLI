import type { Command } from '../../commands.js'

const command = {
  type: 'local-jsx',
  name: 'workflows',
  needsConcourse: true,
  description: 'Workflow run board — active, recent, and past runs; on|off flips this session\'s workflows switch',
  argumentHint: '[on|off]',
  isEnabled: () => true,
  isHidden: false,
  load: () => import('./workflows.js'),
} satisfies Command

export default command
