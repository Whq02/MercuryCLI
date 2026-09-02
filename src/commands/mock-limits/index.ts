import type { Command } from '../../commands.js'
import { flagEnv } from '../../substrate/flagRegistry.js'

// R04: the operator-facing opening of the revived rate-limit
// fixture seam. Exists ONLY behind the registered arm (MERCURY_MOCK_LIMITS) —
// unarmed builds carry no /mock-limits command at all. Scenarios drive the
// REAL header→limits ingestion (extractQuotaStatusFromHeaders), so every
// downstream consumer — statusline, offer card — sees the same truth
// a live response would produce.
const mockLimits: Command = {
  description: 'Drive a deterministic rate-limit scenario (fixture seam)',
  name: 'mock-limits',
  type: 'local',
  supportsNonInteractive: true,
  isEnabled: () => Boolean(flagEnv('MERCURY_MOCK_LIMITS')),
  isHidden: true,
  load: () => import('./mock-limits.js'),
}

export default mockLimits
