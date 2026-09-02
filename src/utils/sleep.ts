/**
 * Abort-responsive delay and a promise timeout race.
 */

type SleepOptions = {
  throwOnAbort?: boolean
  /** Implies throwing. */
  abortError?: () => Error
  /** Unreference the timer so it does not hold the process open. */
  unref?: boolean
}

export function sleep(ms: number, signal?: AbortSignal, opts: SleepOptions = {}): Promise<void> {
  const throwOnAbort = opts.throwOnAbort === true || opts.abortError !== undefined
  const makeError = (): Error => (opts.abortError ? opts.abortError() : new Error('Sleep aborted'))
  // The already-aborted case is decided BEFORE any timer exists.
  if (signal?.aborted) {
    return throwOnAbort ? Promise.reject(makeError()) : Promise.resolve()
  }
  return new Promise<void>((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(timer)
      if (throwOnAbort) reject(makeError())
      else resolve()
    }
    const timer = setTimeout(() => {
      // Registered as a one-shot; remove it on normal completion.
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    if (opts.unref) timer.unref()
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * A deadline on WAITING, not a cancellation: after the deadline the caller
 * gets control back while the underlying operation runs to its own end.
 */
export function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms)
    timer.unref()
    promise.then(
      value => {
        clearTimeout(timer)
        resolve(value)
      },
      err => {
        clearTimeout(timer)
        reject(err)
      },
    )
  })
}
