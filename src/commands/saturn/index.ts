import type { Command } from '../catalogue/commands.js'

const command = {
  type: 'local-jsx',
  name: 'schedule',
  description: 'Schedules (Saturn): the board; with words, schedules it',
  argumentHint: '[what and when]',
  promptWithArgs: true,
  isEnabled: () => true,
  isHidden: false,
  load: () => import('./saturn.js'),
} satisfies Command

export default command
