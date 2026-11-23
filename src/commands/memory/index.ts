import type { Command } from '../catalogue/commands.js'
import { shouldNavCommandBeImmediate } from '../catalogue/immediateCommand.js'

const memory: Command = {
  type: 'local-jsx',
  name: 'memory',
  aliases: ['chronicle'],
  description: 'Open the Memory Centre — facts, pinned rules, maintenance',
  get immediate() {
    return shouldNavCommandBeImmediate()
  },
  load: () => import('./memory.js'),
}

export default memory
