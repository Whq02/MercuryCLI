import { getGlobalConfig, saveGlobalConfig } from '../../utils/config.js'

export function recordTipShown(tipId: string): void {
  saveGlobalConfig(current => {
    const count = current.numStartups ?? 0
    const history = current.tipsHistory ?? {}
    if (history[tipId] === count) return current
    return {
      ...current,
      tipsHistory: {
        ...history,
        [tipId]: count,
      },
    }
  })
}

export function getSessionsSinceLastShown(tipId: string): number {
  const config = getGlobalConfig()
  const lastShown = config.tipsHistory?.[tipId]
  if (!lastShown) return Infinity
  return (config.numStartups ?? 0) - lastShown
}
