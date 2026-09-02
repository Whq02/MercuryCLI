import { createAbortController } from './abortController.js'

export function createCombinedAbortSignal(
  signal: AbortSignal | undefined,
  opts?: { signalB?: AbortSignal; timeoutMs?: number },
): { signal: AbortSignal; cleanup: () => void } {
  const signalB = opts?.signalB
  const timeoutMs = opts?.timeoutMs

  if (signal?.aborted || signalB?.aborted) {
    const controller = createAbortController()
    controller.abort()
    return { signal: controller.signal, cleanup: () => {} }
  }

  const controller = createAbortController()
  let timer: NodeJS.Timeout | undefined

  const clearTimer = (): void => {
    if (timer !== undefined) {
      clearTimeout(timer)
      timer = undefined
    }
  }

  const onAbort = (): void => {
    clearTimer()
    controller.abort()
  }

  signal?.addEventListener('abort', onAbort)
  signalB?.addEventListener('abort', onAbort)

  if (timeoutMs !== undefined) {
    timer = setTimeout(onAbort, timeoutMs)
    timer.unref?.()
  }

  const cleanup = (): void => {
    clearTimer()
    signal?.removeEventListener('abort', onAbort)
    signalB?.removeEventListener('abort', onAbort)
  }

  return { signal: controller.signal, cleanup }
}
