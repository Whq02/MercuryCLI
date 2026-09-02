import type { Command } from '../../commands.js'
import { shouldNavCommandBeImmediate } from '../../utils/immediateCommand.js'

const memory: Command = {
  type: 'local-jsx',
  name: 'memory',
 // 'chronicle' reaches the same front door: the old
  // /chronicle specimen — fictional recall rows — is deleted; the Memory
  // Centre IS the chronicle: facts, lessons, notes, maintenance, receipts).
  aliases: ['chronicle'],
  description: 'Open the Memory Centre — facts, lessons, notes, and upkeep',
  // open immediately, even mid-turn (no queue-until-idle).
  get immediate() {
    return shouldNavCommandBeImmediate()
  },
  load: () => import('./memory.js'),
}

export default memory
