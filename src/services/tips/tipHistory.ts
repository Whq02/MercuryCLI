/**
 * Per-tip "sessions since last shown" bookkeeping in global config.
 *
 * History maps tip id → the startup counter value at the time it was last
 * shown (contract data key `tipsHistory`, alongside `numStartups`).
 */
import { getGlobalConfig, saveGlobalConfig } from '../../utils/config.js'

/**
 * Record that a tip was shown: write the current startup count for that id.
 * When the stored value already equals the current count the updater returns
 * the SAME configuration object by identity, so the config writer's
 * change-detection skips the write (a structurally-equal fresh object would
 * defeat that).
 */
export function recordTipShown(tipId: string): void {
  saveGlobalConfig(current => {
    const startups = current.numStartups ?? 0
    const history = current.tipsHistory ?? {}
    if (history[tipId] === startups) return current
    return { ...current, tipsHistory: { ...history, [tipId]: startups } }
  })
}

/**
 * The current startup count minus the stored value, or +Infinity when there
 * is no stored value. The absence test is a falsiness test, so a stored
 * value of zero also reads as "never shown".
 */
export function getSessionsSinceLastShown(tipId: string): number {
  const config = getGlobalConfig()
  const stored = config.tipsHistory?.[tipId]
  if (!stored) return Number.POSITIVE_INFINITY
  return (config.numStartups ?? 0) - stored
}
