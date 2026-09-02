import type { Command } from '../../commands.js'
import { flagEnv } from '../../substrate/flagRegistry.js'

const command = {
  type: 'local-jsx',
  name: 'daemon',
  description: 'Daemon supervisor · `restart` re-runs it as the deployed build',
  isEnabled: () => (flagEnv('MERCURY_DAEMON_UI') === '0' ? false : true),
  isHidden: false,
  load: () => import('./daemon.js'),
} satisfies Command

export default command
