import { createAbortController } from './abortController.js'
import { startTimeout, stopTimeout } from './timers.js'

export function createCombinedAbortSignal(
  signal: AbortSignal | undefined,
  opts?: { signalB?: AbortSignal; timeoutMs?: number },
): { signal: AbortSignal; cleanup: () => void } {
  const controller = createAbortController()
  const second = opts?.signalB
  if (signal?.aborted || second?.aborted) {
    controller.abort()
    return { signal: controller.signal, cleanup: () => {} }
  }

  let timer: ReturnType<typeof startTimeout> | undefined
  const clearTimer = (): void => {
    if (timer === undefined) return
    stopTimeout(timer)
    timer = undefined
  }
  const abort = (): void => {
    clearTimer()
    controller.abort()
  }
  signal?.addEventListener('abort', abort)
  second?.addEventListener('abort', abort)
  if (opts?.timeoutMs !== undefined) {
    timer = startTimeout(abort, opts.timeoutMs)
    timer.unref?.()
  }

  let cleaned = false
  return {
    signal: controller.signal,
    cleanup() {
      if (cleaned) return
      cleaned = true
      clearTimer()
      signal?.removeEventListener('abort', abort)
      second?.removeEventListener('abort', abort)
    },
  }
}
