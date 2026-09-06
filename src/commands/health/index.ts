import type { Command } from '../../commands.js'
import { flagEnabled } from '../../substrate/flagRegistry.js'

const health: Command = {
  name: 'health',
  description: 'Certify this install — runtime, settings, and channel checked live',
  aliases: ['doctor'],
  isEnabled: () => flagEnabled('MERCURY_DOCTOR_COMMAND'),
  type: 'local-jsx',
  load: () => import('./health.js'),
}

export default health
