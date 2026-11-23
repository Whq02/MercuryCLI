import type { Command } from '../catalogue/commands.js'
import { zenModeOn } from '../../screen/cockpit/zenMode.js'
import { shouldNavCommandBeImmediate } from '../catalogue/immediateCommand.js'

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
