import type { Command } from '../../commands.js'


const command = {
  type: 'local-jsx',
  name: 'run',
  description: 'Live run inspector — objective, deliverables, effects, evidence, next action',
  isEnabled: () => true,
  isHidden: false,
  load: () => import('./run.js'),
} satisfies Command

export default command
