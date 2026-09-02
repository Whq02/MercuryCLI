import { getSettings_DEPRECATED } from '../../utils/settings/settings.js'
import { getRelevantTips } from './tipRegistry.js'
import { recordTipShown } from './tipHistory.js'
import { getSessionsSinceLastShown } from './tipHistory.js'
import type { Tip, TipContext } from './types.js'

export function selectTipWithLongestTimeSinceShown(tips: Tip[]): Tip | undefined {
  if (tips.length === 0) return undefined
  if (tips.length === 1) return tips[0]
  const ranked = tips
    .map((tip, index) => ({ tip, index, since: getSessionsSinceLastShown(tip.id) }))
    .sort((a, b) => b.since - a.since || a.index - b.index)
  return ranked[0]?.tip
}

export async function getTipToShowOnSpinner(context?: TipContext): Promise<Tip | undefined> {
  if (getSettings_DEPRECATED().spinnerTipsEnabled === false) return undefined
  const tips = await getRelevantTips(context)
  return selectTipWithLongestTimeSinceShown(tips)
}

export function recordShownTip(tip: Tip): void {
  recordTipShown(tip.id)
}
