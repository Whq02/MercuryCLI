import type { Command } from '../../commands.js'
import { isEnvTruthy } from '../../utils/envUtils.js'

// /health — the Mercury install health certificate named the
// command; the rebuild landed the whole layer under its
// health name — files, symbols, and copy). The DISABLE_DOCTOR_COMMAND
// env stays decoded as external-harness compat input, and `doctor` stays a
// working ALIAS (HL-03/21) for operators and external automation.
const health: Command = {
  name: 'health',
  description: 'Certify this install — runtime, settings, and channel checked live',
  // seam fix: the Boot journeys historically dispatch '/doctor' —
  // findCommand is exact-match, so the alias must live HERE, not only on the
  // CLI verb, or the journey lands on Unknown command.
  aliases: ['doctor'],
  isEnabled: () => !isEnvTruthy(process.env.DISABLE_DOCTOR_COMMAND),
  type: 'local-jsx',
  load: () => import('./health.js'),
}

export default health
