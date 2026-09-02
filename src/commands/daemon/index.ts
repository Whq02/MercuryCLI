import type { Command } from '../../commands.js'
import { flagEnv } from '../../substrate/flagRegistry.js'

// /daemon — mounts the Mercury DaemonSupervisorView control-plane cockpit (live
// supervisor RPC). Mirrors /trace · /substrate (historically stamp-gated;
// unconditional). MERCURY_DAEMON_UI=0 ⇒ the
// view never mounts.
const command = {
  type: 'local-jsx',
  name: 'daemon',
  description: 'Daemon supervisor · `restart` re-runs it as the deployed build',
  isEnabled: () => (flagEnv('MERCURY_DAEMON_UI') === '0' ? false : true),
  isHidden: false,
  load: () => import('./daemon.js'),
} satisfies Command

export default command
