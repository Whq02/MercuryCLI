import type { Command } from '../../commands.js'

const command = {
  type: 'local-jsx',
  name: 'saturn',
  description: 'Schedules — next fire · held fires · pause/run-now (Saturn)',
  isEnabled: () => true,
  isHidden: false,
  load: () => import('./saturn.js'),
} satisfies Command

export default command
