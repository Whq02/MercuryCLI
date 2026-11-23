import { getInitialSettings } from '../../platform/settings/settings.js'
import { getRelevantTips } from './tipRegistry.js'
import { recordTipShown } from './tipHistory.js'
import { getSessionsSinceLastShown } from './tipHistory.js'
import type { Tip, TipContext } from './types.js'

export function selectTipWithLongestTimeSinceShown(tips: Tip[]): Tip | undefined {
  if (tips.length === 0) return undefined
  if (tips.length === 1) return tips[0]
  let selected = tips[0]!
  let maxSessions = getSessionsSinceLastShown(selected.id)
  for (let i = 1; i < tips.length; i++) {
    const tip = tips[i]!
    const sessions = getSessionsSinceLastShown(tip.id)
    if (sessions > maxSessions) {
      selected = tip
      maxSessions = sessions
    }
  }
  return selected
}

export async function getTipToShowOnSpinner(context?: TipContext): Promise<Tip | undefined> {
  if (getInitialSettings().activity?.tips?.enabled === false) return undefined
  const relevantTips = await getRelevantTips(context)
  return selectTipWithLongestTimeSinceShown(relevantTips)
}

export function recordShownTip(tip: Tip): void {
  recordTipShown(tip.id)
}
