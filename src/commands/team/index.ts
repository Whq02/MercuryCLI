import type { Command } from '../../commands.js'

const team = {
  type: 'local-jsx',
  name: 'team',
  description: 'Team Center — your teammates, their phases, and handoffs',
  isEnabled: () => true,
  isHidden: false,
  load: () => import('../tasks/tasks.js'),
} satisfies Command

export default team
