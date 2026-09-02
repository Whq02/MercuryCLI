import { flagEnv } from '../../substrate/flagRegistry.js'
import { isEnvDefinedFalsy, isEnvTruthy } from '../../utils/envUtils.js'
import { approvedChannelFor } from '../../extensions/load/channels.js'

/**
 * The channels master gate and the channel approvals. An extension's
 * server may post channel messages into the session when the extension is
 * approved, switched on, its `channels` switch is on and the manifest lists
 * that server under `channels` — the approval card is the consent. No
 * remote ledger feeds this; nothing is approved by default.
 */

/**
 * The master gate (Mercury polarity): `MERCURY_CHANNELS` is the hard
 * override — a defined falsy value forces off, a truthy value forces on;
 * otherwise the feature is ON (Mercury runs its own local channel bus).
 */
export function isChannelsEnabled(): boolean {
  const flag = flagEnv('MERCURY_CHANNELS')
  if (isEnvDefinedFalsy(flag)) return false
  if (isEnvTruthy(flag)) return true
  return true
}

/**
 * Standalone approval check for UI pre-filtering. Explicitly NOT a security
 * boundary — registration still runs the full gate.
 */
export function isChannelApproved(serverName: string | undefined): boolean {
  if (serverName === undefined || serverName === '') return false
  return approvedChannelFor(serverName) !== null
}
