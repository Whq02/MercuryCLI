import { getGlobalConfig, saveGlobalConfig } from '../../utils/config.js'

export function recordTipShown(tipId: string): void {
  saveGlobalConfig(current => {
    const startups = current.numStartups ?? 0
    const history = current.tipsHistory ?? {}
    if (history[tipId] === startups) return current
    return { ...current, tipsHistory: { ...history, [tipId]: startups } }
  })
}

export function getSessionsSinceLastShown(tipId: string): number {
  const config = getGlobalConfig()
  const stored = config.tipsHistory?.[tipId]
  if (!stored) return Number.POSITIVE_INFINITY
  return (config.numStartups ?? 0) - stored
}
