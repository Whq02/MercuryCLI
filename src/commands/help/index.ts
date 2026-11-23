import type { Command } from '../catalogue/commands.js'
import { shouldNavCommandBeImmediate } from '../catalogue/immediateCommand.js'

const help = {
  type: 'local-jsx',
  name: 'help',
  description: 'Browse every command Mercury answers to',
  get immediate() {
    return shouldNavCommandBeImmediate()
  },
  load: () => import('./help.js'),
} satisfies Command

export default help
