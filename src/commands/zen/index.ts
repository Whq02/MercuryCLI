import type { Command } from '../../commands.js'
import { zenModeOn } from '../../utils/cockpit/zenMode.js'
import { shouldNavCommandBeImmediate } from '../../utils/immediateCommand.js'

export default {
  type: 'local-jsx',
  name: 'zen',
  description: 'Zen mode — hide the lanes and vitals rails for a full-width chat; saved for later boots',
  currentValue: () => (zenModeOn() ? 'on' : 'off'),
  argumentHint: '[on|off]',
  get immediate() {
    return shouldNavCommandBeImmediate()
  },
  load: () => import('./zen.js'),
} satisfies Command
