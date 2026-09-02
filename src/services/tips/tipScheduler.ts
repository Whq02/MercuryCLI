/**
 * Tip selection (longest-unshown) and the shown-recording step.
 */
import { getSettings_DEPRECATED } from '../../utils/settings/settings.js'
import { getRelevantTips } from './tipRegistry.js'
import { recordTipShown } from './tipHistory.js'
import { getSessionsSinceLastShown } from './tipHistory.js'
import type { Tip, TipContext } from './types.js'

/**
 * Select the tip least-recently shown. An empty list yields nothing; a SINGLE
 * candidate is returned directly without any history lookup; otherwise each
 * candidate is paired with its sessions-since-last-shown and the list is
 * sorted descending (stable, so equal candidates resolve to the earliest in
 * catalogue order), first wins.
 */
export function selectTipWithLongestTimeSinceShown(tips: Tip[]): Tip | undefined {
  if (tips.length === 0) return undefined
  if (tips.length === 1) return tips[0]
  const ranked = tips
    .map((tip, index) => ({ tip, index, since: getSessionsSinceLastShown(tip.id) }))
    .sort((a, b) => b.since - a.since || a.index - b.index)
  return ranked[0]?.tip
}

/**
 * The tip to show on the spinner. Nothing when the tips setting is
 * explicitly false (read from the merged settings reader; unset means
 * enabled).
 */
export async function getTipToShowOnSpinner(context?: TipContext): Promise<Tip | undefined> {
  if (getSettings_DEPRECATED().spinnerTipsEnabled === false) return undefined
  const tips = await getRelevantTips(context)
  return selectTipWithLongestTimeSinceShown(tips)
}

/** Record a shown tip (a separate, caller-invoked step). */
export function recordShownTip(tip: Tip): void {
  recordTipShown(tip.id)
}
