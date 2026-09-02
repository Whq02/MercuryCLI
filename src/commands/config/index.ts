import type { Command } from '../../commands.js'
import { shouldNavCommandBeImmediate } from '../../utils/immediateCommand.js'

const config = {
  aliases: ['settings'],
  type: 'local-jsx',
  name: 'config',
  description: 'Open the config panel',
  get immediate() {
    return shouldNavCommandBeImmediate()
  },
  load: () => import('./config.js'),
} satisfies Command

export default config
