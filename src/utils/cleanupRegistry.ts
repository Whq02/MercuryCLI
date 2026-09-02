/**
 * Process-global registry of async shutdown cleanup functions.
 *
 * Deliberately separate from the graceful-shutdown module so registering a
 * cleanup never pulls that module (and its import graph) in — the shutdown
 * path imports this registry, not the other way around.
 */
const cleanupFunctions = new Set<() => Promise<void>>()

/**
 * Register a cleanup function. The registry is a set keyed by function
 * identity, so registering the same reference twice leaves one entry.
 * Returns an unregister function; calling it twice, or after the registry
 * has already run, is harmless.
 */
export function registerCleanup(fn: () => Promise<void>): () => void {
  cleanupFunctions.add(fn)
  return () => {
    cleanupFunctions.delete(fn)
  }
}

/**
 * Invoke every registered cleanup concurrently and wait for ALL of them to
 * SETTLE; the first rejection then propagates to the caller. The aggregate
 * settling early was the win32 exit-cliff hole: Promise.all rejected on the
 * FIRST failing cleanup while its siblings' file I/O was still in the
 * threadpool, so gracefulShutdown's 400ms quiescence — built for exactly
 * those in-flight completions (the 0xC0000409 family) — saw a settled
 * promise and granted ZERO grace (TASK-017 S2,
 * cleanup-promise-all-collapses-exit-quiescence). allSettled-then-throw
 * keeps both contracts: the caller still sees the first failure, and a
 * settled aggregate now really means every cleanup finished.
 * Running does not empty the registry; a second run re-invokes everything
 * still registered.
 */
export async function runCleanupFunctions(): Promise<void> {
  const results = await Promise.allSettled([...cleanupFunctions].map(fn => fn()))
  const firstRejection = results.find(r => r.status === 'rejected')
  if (firstRejection) throw (firstRejection as PromiseRejectedResult).reason
}
