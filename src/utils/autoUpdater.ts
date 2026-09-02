import { MERCURY_VERSION } from '../constants/product.js'
import { getDynamicConfig_BLOCKS_ON_INIT } from '../services/analytics/featureGates.js'
import { gracefulShutdownSync } from './gracefulShutdown.js'
import { logError } from './log.js'
import { lt } from './semver.js'

/**
 * Boot-time minimum-version assertion plus deliberately no-network dist-tag
 * stubs.
 *
 * The auto-update machinery of old (locks, install prefixes, registry/bucket
 * version fetchers, global package installation, shell-alias cleanup, the
 * maximum-version kill switch) is deliberately absent and must not be
 * reintroduced — Mercury updates through the private release channel.
 */

/**
 * Refuse to run when the build is older than the gate-configured minimum
 * version. Inert in practice (the gate never fetches, so the default 0.0.0
 * floor is returned), but kept because it is the documented check.
 */
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
      // The below-minimum refusal exits through the synchronous graceful-
      // shutdown entry point, never a raw process exit.
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

/**
 * No-network stub. There is no published version feed corresponding to a
 * private source build: asking the upstream package registry would answer
 * with a version that is not Mercury's — and, unreachable from a fork, it
 * would fail and make the doctor screen print a spurious fetch-failure
 * line. With null/null the doctor shows a "not applicable to a source
 * build" line instead.
 */
export async function getNpmDistTags(): Promise<NpmDistTags> {
  return { latest: null, stable: null }
}

/** No-network stub; see getNpmDistTags. */
export async function getGcsDistTags(): Promise<NpmDistTags> {
  return { latest: null, stable: null }
}
