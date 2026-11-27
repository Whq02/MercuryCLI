import type { Command } from '../catalogue/commands.js'
import { shouldNavCommandBeImmediate } from '../catalogue/immediateCommand.js'

export default {
  type: 'local-jsx',
  name: 'browse',
  description: 'Browse the project files — the file browser the files panel opens, from the composer in every layout',
  get immediate() {
    return shouldNavCommandBeImmediate()
  },
  load: () => import('./browse.js'),
} satisfies Command
