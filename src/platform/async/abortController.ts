import { setMaxListeners } from 'node:events'

export function createAbortController(maxListeners = 50): AbortController {
  const controller = new AbortController()
  setMaxListeners(maxListeners, controller.signal)
  return controller
}

export function createChildAbortController(
  parent: AbortController,
  maxListeners?: number,
): AbortController {
  const child = createAbortController(maxListeners)
  const signal = parent.signal
  if (signal.aborted) {
    child.abort(signal.reason)
    return child
  }
  const childRef = new WeakRef(child)
  const parentRef = new WeakRef(signal)
  function abortChild(this: AbortSignal): void {
    childRef.deref()?.abort(this.reason)
  }
  signal.addEventListener('abort', abortChild, { once: true })
  child.signal.addEventListener('abort', () => parentRef.deref()?.removeEventListener('abort', abortChild), { once: true })
  return child
}
