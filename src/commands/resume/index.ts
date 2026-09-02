import type { Command } from '../../commands.js'
import { shouldNavCommandBeImmediate } from '../../utils/immediateCommand.js'

const resume: Command = {
  type: 'local-jsx',
  name: 'resume',
  description: 'Reopen an earlier session and keep working',
  // open immediately, even mid-turn (no queue-until-idle).
  get immediate() {
    return shouldNavCommandBeImmediate()
  },
  aliases: ['continue'],
  argumentHint: '[session id or search text]',
  load: () => import('./resume.js'),
}

export default resume
