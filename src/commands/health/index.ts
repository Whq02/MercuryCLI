import type { Command } from '../../commands.js'
import { isEnvTruthy } from '../../utils/envUtils.js'

const health: Command = {
  name: 'health',
  description: 'Certify this install — runtime, settings, and channel checked live',
  aliases: ['doctor'],
  isEnabled: () => !isEnvTruthy(process.env.DISABLE_DOCTOR_COMMAND),
  type: 'local-jsx',
  load: () => import('./health.js'),
}

export default health
