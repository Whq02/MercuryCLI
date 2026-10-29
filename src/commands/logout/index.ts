import type { Command } from '../../commands.js'
import { flagEnabled } from '../../substrate/flagRegistry.js'
import { shouldNavCommandBeImmediate } from '../../utils/immediateCommand.js'

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
