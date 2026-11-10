import type { Command } from '../../commands.js'
import { flagEnabled } from '../../substrate/flagRegistry.js'

const command = {
  type: 'local-jsx',
  name: 'daemon',
  description: 'The daemon and its workers · `restart` re-runs it as the deployed build · `halt` hard-stops every daemon and crewmate',
  argumentHint: '[restart | halt]',
  headlessVerbs: ['halt'],
  isEnabled: () => flagEnabled('MERCURY_DAEMON_UI'),
  isHidden: false,
  load: () => import('./daemon.js'),
} satisfies Command

export default command
