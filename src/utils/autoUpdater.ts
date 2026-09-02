import { MERCURY_VERSION } from '../constants/product.js'
import { getDynamicConfig_BLOCKS_ON_INIT } from '../services/analytics/featureGates.js'
import { gracefulShutdownSync } from './gracefulShutdown.js'
import { logError } from './log.js'
import { lt } from './semver.js'


export async function assertMinVersion(): Promise<void> {
  if (process.env.NODE_ENV === 'test') return
  try {
    const config = await getDynamicConfig_BLOCKS_ON_INIT<{ minVersion: string }>(
      'mercury_version_config',
      { minVersion: '0.0.0' },
    )
    const minVersion = config.minVersion
    if (minVersion && lt(MERCURY_VERSION, minVersion)) {
      console.error(
        `Mercury ${MERCURY_VERSION} is older than the required minimum version ${minVersion}. ` +
          `Update with \`mercury update\`, or rebuild from the source checkout.`,
      )
      gracefulShutdownSync(1)
    }
  } catch (err) {
    logError(err)
  }
}

export type NpmDistTags = {
  latest: string | null
  stable: string | null
}

export async function getNpmDistTags(): Promise<NpmDistTags> {
  return { latest: null, stable: null }
}

export async function getGcsDistTags(): Promise<NpmDistTags> {
  return { latest: null, stable: null }
}
