import type { Command } from '../../commands.js'
import { shouldNavCommandBeImmediate } from '../../utils/immediateCommand.js'

export default {
  type: 'local-jsx',
  name: 'browse',
  description: 'Browse the project files — the file browser the FILES card opens, from the composer in every layout',
  get immediate() {
    return shouldNavCommandBeImmediate()
  },
  load: () => import('./browse.js'),
} satisfies Command
