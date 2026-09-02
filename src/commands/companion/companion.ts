import type { LocalCommandResult } from '../../types/command.js'
import { flagEnv } from '../../substrate/flagRegistry.js'
import {
  isDeckCompanionEnabled,
  setCompanionEnabled,
} from '../../components/mercury-ui/useCompanion.js'
import { requestCompanionTip } from '../../utils/cockpit/companionEngine.js'

// The /companion body: `on` · `off` · bare (toggle) · `tip` (one tip now).
// An explicit MERCURY_DECK_COMPANION env pin wins over the persisted choice
// at read time — the ack says so instead of lying about a flip that can't
// take effect.
export async function call(args: string): Promise<LocalCommandResult> {
  const want = args.trim().toLowerCase()
  if (want === 'tip') {
    // On demand: the explicit ask outranks the cadence and quiet mode; the
    // seen-tip memory still steers the pick. The line also shows on the
    // companion row while the companion is on.
    const tip = requestCompanionTip()
    return {
      type: 'text',
      value: tip ? `tip — ${tip}` : 'no tip to give right now',
    }
  }
  const next = want === 'on' ? true : want === 'off' ? false : !isDeckCompanionEnabled()
  setCompanionEnabled(next)
  const envPin = flagEnv('MERCURY_DECK_COMPANION')
  const pinNote =
    envPin === '1' && !next
      ? ' — note: MERCURY_DECK_COMPANION=1 is pinned, so it stays visible until that env is unset'
      : envPin === '0' && next
        ? ' — note: MERCURY_DECK_COMPANION=0 is pinned, so it stays hidden until that env is unset'
        : ''
  return {
    type: 'text',
    value: next
      ? `companion on — your session creature keeps you company (a word at the right moment · a tip now and then · /companion tip for one now)${pinNote}`
      : `companion off — the critter goes back to silent decoration${pinNote}`,
  }
}
