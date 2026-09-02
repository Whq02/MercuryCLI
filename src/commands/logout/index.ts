import type { Command } from '../../commands.js'
import { isEnvTruthy } from '../../utils/envUtils.js'
import { shouldNavCommandBeImmediate } from '../../utils/immediateCommand.js'

export default {
  type: 'local-jsx',
  name: 'logout',
  description: 'Sign out everywhere — credentials and caches cleared',
  isEnabled: () => !isEnvTruthy(process.env.DISABLE_LOGOUT_COMMAND),
  // Opens immediately, even mid-turn (auth changes take effect immediately).
  get immediate() {
    return shouldNavCommandBeImmediate()
  },
  load: () => import('./logout.js'),
} satisfies Command
