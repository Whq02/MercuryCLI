export class DapCancelledError extends Error {
  constructor() {
    super('debug operation cancelled')
    this.name = 'AbortError'
  }
}

export function throwIfDapAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DapCancelledError()
}

export function dapDeadline(callback: () => void, timeoutMs: number): () => void {
  const deadline = Date.now() + timeoutMs
  let timer: ReturnType<typeof setTimeout>
  const tick = (): void => {
    const remaining = deadline - Date.now()
    if (remaining <= 0) callback()
    else timer = setTimeout(tick, Math.min(remaining, 2_147_483_647))
  }
  timer = setTimeout(tick, Math.min(timeoutMs, 2_147_483_647))
  return () => clearTimeout(timer)
}

export function waitForDap<T>(promise: Promise<T>, signal?: AbortSignal, timeoutMs?: number): Promise<T | undefined> {
  throwIfDapAborted(signal)
  return new Promise((resolve, reject) => {
    let cancelDeadline: (() => void) | undefined
    const cleanup = (): void => {
      cancelDeadline?.()
      signal?.removeEventListener('abort', onAbort)
    }
    const onAbort = (): void => { cleanup(); reject(new DapCancelledError()) }
    signal?.addEventListener('abort', onAbort, { once: true })
    if (timeoutMs !== undefined) cancelDeadline = dapDeadline(() => { cleanup(); resolve(undefined) }, timeoutMs)
    promise.then(value => { cleanup(); resolve(value) }, error => { cleanup(); reject(error) })
  })
}
