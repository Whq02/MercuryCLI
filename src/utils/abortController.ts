import { setMaxListeners } from 'node:events'


const DEFAULT_MAX_LISTENERS = 50

export function createAbortController(maxListeners: number = DEFAULT_MAX_LISTENERS): AbortController {
  const controller = new AbortController()
  setMaxListeners(maxListeners, controller.signal)
  return controller
}

export function createChildAbortController(
  parent: AbortController,
  maxListeners?: number,
): AbortController {
  const child = createAbortController(maxListeners)

  if (parent.signal.aborted) {
    child.abort(parent.signal.reason)
    return child
  }

  const childRef = new WeakRef(child)
  const parentSignalRef = new WeakRef(parent.signal)

  const onParentAbort = (): void => {
    const liveChild = childRef.deref()
    if (!liveChild) return
    liveChild.abort(parentSignalRef.deref()?.reason)
  }

  parent.signal.addEventListener('abort', onParentAbort)

  child.signal.addEventListener(
    'abort',
    () => {
      parentSignalRef.deref()?.removeEventListener('abort', onParentAbort)
    },
    { once: true },
  )

  return child
}
