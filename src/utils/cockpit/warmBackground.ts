
import { isEnvTruthy } from '../envUtils.js'
import { exitOasisBg, noteOriginalGroundReply } from './oasisBg.js'
import { flagEnv } from '../../substrate/flagRegistry.js'

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
