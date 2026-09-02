import type { Command } from '../../commands.js'
import { shouldNavCommandBeImmediate } from '../../utils/immediateCommand.js'

const exportCommand = {
  type: 'local-jsx',
  name: 'export',
  description: 'Save this conversation to a file, or copy it whole',
  argumentHint: '[filename]',
  // open immediately, even mid-turn (no queue-until-idle).
  get immediate() {
    return shouldNavCommandBeImmediate()
  },
  load: () => import('./export.js'),
} satisfies Command

export default exportCommand
