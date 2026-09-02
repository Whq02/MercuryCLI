import type { Command } from '../../commands.js'

const command = {
  type: 'local-jsx',
  name: 'workflows',
  needsConcourse: true,
  description: 'Workflow run board — active, recent, and past runs',
  isEnabled: () => true,
  isHidden: false,
  load: () => import('./workflows.js'),
} satisfies Command

export default command
