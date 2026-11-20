import { startTimeout, stopTimeout } from './timers.js'

type SleepOptions = {
  throwOnAbort?: boolean
  abortError?: () => Error
  unref?: boolean
}

export function sleep(ms: number, signal?: AbortSignal, opts: SleepOptions = {}): Promise<void> {
  const throwOnAbort = opts.throwOnAbort === true || opts.abortError !== undefined
  const makeError = (): Error => (opts.abortError ? opts.abortError() : Object.assign(new Error('The operation was aborted', { cause: signal?.reason }), { code: 'ABORT_ERR', name: 'AbortError' }))
  if (signal?.aborted) {
    return throwOnAbort ? Promise.reject(makeError()) : Promise.resolve()
  }
  return new Promise<void>((resolve, reject) => {
    const onAbort = (): void => {
      stopTimeout(timer)
      if (throwOnAbort) reject(makeError())
      else resolve()
    }
    const timer = startTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    if (opts.unref) timer.unref?.()
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}
