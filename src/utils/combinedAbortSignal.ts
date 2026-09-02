import { createAbortController } from './abortController.js'

/**
 * Combine up to two abort signals plus an optional timeout into one signal
 * with an explicit cleanup function.
 *
 * The combined signal deliberately never carries a source reason: every abort
 * path aborts the internal controller with no argument, so the resulting
 * reason is the runtime's default abort error. Consumers (notably the shell
 * command interrupt branch) key on an exact reason string and must never
 * start receiving a propagated one.
 *
 * The timeout is an ordinary clearable, unreferenced timer — deliberately not
 * the runtime's own timeout-signal helper, whose timers are reclaimed only
 * lazily on Bun and pin native memory until they fire; a clearable timer
 * releases at cleanup.
 */
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

  // Every abort path clears the pending timer first, so a signal-driven abort
  // leaves no live timer behind even without a cleanup() call.
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
