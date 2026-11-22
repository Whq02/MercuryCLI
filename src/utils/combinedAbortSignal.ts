import { createAbortController } from './abortController.js'
import { startTimeout, stopTimeout } from './timers.js'
import { notBuilt } from '../pi/holes.js'

export function createCombinedAbortSignal(
  signal: AbortSignal | undefined,
  opts?: { signalB?: AbortSignal; timeoutMs?: number },
): { signal: AbortSignal; cleanup: () => void } {
  return notBuilt('src/utils/combinedAbortSignal.ts:4')
}
