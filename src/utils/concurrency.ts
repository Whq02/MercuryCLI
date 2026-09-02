// ============================================================================
//  utils/concurrency — mapWithConcurrency: a small ORDER-PRESERVING worker
//  pool over an item list. Results land at their item's own index whatever
//  the completion order, so a caller reads exactly what a serial map would
//  have produced — the pool changes latency, never shape. Width is the
//  caller's; size it from availableCores (law 6: every seam that sizes a
//  pool reads the quota-aware count), and keep it SMALL for disk metadata
//  fan-outs — libuv serves fs work from a four-thread pool by default, and
//  a wall of queued promises past it only burns memory.
//
//  A rejection from fn rejects the whole map (workers finish the item in
//  their hands and stop pulling); callers that tolerate per-item failure
//  catch INSIDE fn — the session-discovery scans all do.
// ============================================================================

export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length)
  if (items.length === 0) return results
  const width = Math.max(1, Math.min(Math.floor(limit), items.length))
  let next = 0
  let failed = false
  const workers = Array.from({ length: width }, async () => {
    while (!failed) {
      const index = next++
      if (index >= items.length) return
      try {
        results[index] = await fn(items[index]!, index)
      } catch (e) {
        failed = true
        throw e
      }
    }
  })
  await Promise.all(workers)
  return results
}
