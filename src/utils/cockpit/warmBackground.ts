
import { NIGHT } from '../../components/mercuryPalette.js'
import { osc } from '../../ink/termio/osc.js'
import { isEnvTruthy } from '../envUtils.js'
import { _resetGroundForTest, exitOasisBg, noteOriginalGroundReply } from './oasisBg.js'
import { flagEnv } from '../../substrate/flagRegistry.js'

const OSC_BG = 11

export function isWarmBackgroundEnabled(): boolean {
  return isEnvTruthy(flagEnv('MERCURY_WARM_BG'))
}

export function applyWarmBackground(
  originalSpec: string,
  stdout: NodeJS.WriteStream,
): void {
  noteOriginalGroundReply(originalSpec, s => stdout.write(s))
}

export function restoreOriginalBackground(): void {
  exitOasisBg()
}

export function _resetWarmBackgroundForTest(): void {
  _resetGroundForTest()
}
