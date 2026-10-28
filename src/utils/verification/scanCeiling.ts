import { flagEnv } from '../../substrate/flagRegistry.js'

export const DEFAULT_SCAN_CEILING = 100_000

export function scanCeiling(): number {
  const raw = Number(flagEnv('MERCURY_TREE_SCAN_CEILING'))
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : DEFAULT_SCAN_CEILING
}
