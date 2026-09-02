
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
