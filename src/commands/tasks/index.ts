import type { Command } from '../../commands.js'

const tasks = {
  type: 'local-jsx',
  name: 'tasks',
  aliases: ['bashes'],
  description: 'The background board — running shells and agents, with detail cards',
  load: () => import('./tasks.js'),
} satisfies Command

export default tasks
