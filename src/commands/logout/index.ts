import type { Command } from '../catalogue/commands.js'
import { flagEnabled } from '../../platform/substrate/flagRegistry.js'
import { shouldNavCommandBeImmediate } from '../catalogue/immediateCommand.js'

export default {
  type: 'local-jsx',
  name: 'logout',
  description: 'Sign out everywhere — credentials and caches cleared',
  isEnabled: () => flagEnabled('MERCURY_LOGOUT_COMMAND'),
  get immediate() {
    return shouldNavCommandBeImmediate()
  },
  load: () => import('./logout.js'),
} satisfies Command
