import type { Command } from '../../commands.js'
import { shouldNavCommandBeImmediate } from '../../utils/immediateCommand.js'

const help = {
  type: 'local-jsx',
  name: 'help',
  description: 'Browse every command Mercury answers to',
  // open immediately, even mid-turn (no queue-until-idle).
  get immediate() {
    return shouldNavCommandBeImmediate()
  },
  load: () => import('./help.js'),
} satisfies Command

export default help
