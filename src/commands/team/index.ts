import type { Command } from '../../commands.js'

const team = {
  type: 'local-jsx',
  name: 'team',
  description: 'Crew board — the named agents, their phases and handoffs (on /tasks)',
  isEnabled: () => true,
  isHidden: false,
  load: () => import('../tasks/tasks.js'),
} satisfies Command

export default team
