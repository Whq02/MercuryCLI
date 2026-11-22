import { startTimeout, stopTimeout } from './timers.js'
import { notBuilt } from '../pi/holes.js'

type SleepOptions = {
  throwOnAbort?: boolean
  abortError?: () => Error
  unref?: boolean
}

export function abortedError(signal: AbortSignal | undefined): Error {
  return Object.assign(new Error('The operation was aborted', { cause: signal?.reason }), { code: 'ABORT_ERR', name: 'AbortError' })
}

export function sleep(ms: number, signal?: AbortSignal, opts?: SleepOptions): Promise<void> {
  return notBuilt('src/utils/sleep.ts:13')
}
