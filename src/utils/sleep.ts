import { startTimeout, stopTimeout } from './timers.js'

type SleepOptions = {
  throwOnAbort?: boolean
  abortError?: () => Error
  unref?: boolean
}

export function abortedError(signal: AbortSignal | undefined): Error {
  return Object.assign(new Error('The operation was aborted', { cause: signal?.reason }), { code: 'ABORT_ERR', name: 'AbortError' })
}

export function sleep(ms: number, signal?: AbortSignal, opts: SleepOptions = {}): Promise<void> {
  return new Promise((resolve, reject) => {
    const finishAbort = () => {
      if (opts.abortError || opts.throwOnAbort === true) reject(opts.abortError ? opts.abortError() : abortedError(signal))
      else resolve()
    }
    if (signal?.aborted) {
      finishAbort()
      return
    }
    const timer = startTimeout(() => {
      signal?.removeEventListener('abort', abort)
      resolve()
    }, ms)
    function abort() {
      stopTimeout(timer)
      finishAbort()
    }
    if (opts.unref) timer.unref?.()
    signal?.addEventListener('abort', abort, { once: true })
  })
}
