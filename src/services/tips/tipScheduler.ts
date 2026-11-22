import { getInitialSettings } from '../../utils/settings/settings.js'
import { getRelevantTips } from './tipRegistry.js'
import { recordTipShown } from './tipHistory.js'
import { getSessionsSinceLastShown } from './tipHistory.js'
import type { Tip, TipContext } from './types.js'
import { notBuilt } from '../../pi/holes.js'

export function selectTipWithLongestTimeSinceShown(tips: Tip[]): Tip | undefined {
  return notBuilt('src/services/tips/tipScheduler.ts:7')
}

export async function getTipToShowOnSpinner(context?: TipContext): Promise<Tip | undefined> {
  return notBuilt('src/services/tips/tipScheduler.ts:16')
}

export function recordShownTip(tip: Tip): void {
  return notBuilt('src/services/tips/tipScheduler.ts:22')
}
