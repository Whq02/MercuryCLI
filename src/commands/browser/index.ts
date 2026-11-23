import type { Command } from '../catalogue/commands.js'
import { flagEnabled } from '../../platform/substrate/flagRegistry.js'


const browser: Command = {
  type: 'local',
  name: 'browser',
  description:
    'Browser driver status · install/remove the managed Chrome-for-Testing build (explicit consented download)',
  argumentHint: '[status | install | remove <buildId>]',
  supportsNonInteractive: true,
  isEnabled: () => flagEnabled('MERCURY_BROWSER'),
  load: () => import('./browserCommand.js'),
}

export default browser
