import type { Command } from '../../commands.js'

const tasks = {
  type: 'local-jsx',
  name: 'runs',
  aliases: ['tasks'],
  description: 'The runs board — running shells and agents, with detail cards',
  load: () => import('./tasks.js'),
} satisfies Command

export default tasks
