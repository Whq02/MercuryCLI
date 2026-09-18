import type { Command } from '../../commands.js'
import { flagEnv } from '../../substrate/flagRegistry.js'

const mockLimits: Command = {
  description: 'Drive a deterministic rate-limit scenario (fixture seam)',
  name: 'mock-limits',
  type: 'local',
  seat: 'screen',
  supportsNonInteractive: true,
  isEnabled: () => Boolean(flagEnv('MERCURY_MOCK_LIMITS')),
  isHidden: true,
  load: () => import('./mock-limits.js'),
}

export default mockLimits
