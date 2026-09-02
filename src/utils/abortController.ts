import { setMaxListeners } from 'node:events'

/**
 * AbortController factory with a raised listener cap, plus a GC-safe
 * parent→child abort link.
 */

const DEFAULT_MAX_LISTENERS = 50

/**
 * Create an AbortController whose signal accepts many listeners without the
 * runtime's max-listeners warning.
 */
export function createAbortController(maxListeners: number = DEFAULT_MAX_LISTENERS): AbortController {
  const controller = new AbortController()
  setMaxListeners(maxListeners, controller.signal)
  return controller
}

/**
 * Create a controller that aborts when `parent` aborts, carrying the parent's
 * abort reason. Aborting the child never aborts the parent.
 *
 * Memory contract (load-bearing):
 * - The parent holds only a weak reference to the child, so a child that is
 *   dropped without ever aborting stays collectable.
 * - When the child aborts from any source, the listener it installed on the
 *   parent is removed, so a long-lived parent does not accumulate one stale
 *   listener per finished child.
 * - Either side may already have been collected when the other fires; cleanup
 *   after collection is a silent no-op.
 */
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
