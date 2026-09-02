
type SleepOptions = {
  throwOnAbort?: boolean
  abortError?: () => Error
  unref?: boolean
}

export function sleep(ms: number, signal?: AbortSignal, opts: SleepOptions = {}): Promise<void> {
  const throwOnAbort = opts.throwOnAbort === true || opts.abortError !== undefined
  const makeError = (): Error => (opts.abortError ? opts.abortError() : new Error('Sleep aborted'))
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
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    if (opts.unref) timer.unref()
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

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
