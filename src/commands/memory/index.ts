import type { Command } from '../../commands.js'
import { shouldNavCommandBeImmediate } from '../../utils/immediateCommand.js'

const memory: Command = {
  type: 'local-jsx',
  name: 'memory',
  aliases: ['chronicle'],
  description: 'Open the Memory Centre — facts, lessons, notes, and upkeep',
  get immediate() {
    return shouldNavCommandBeImmediate()
  },
  load: () => import('./memory.js'),
}

export default memory
