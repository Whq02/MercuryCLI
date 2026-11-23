import { availableCores } from '../processes/availableCores.js'

export function discoveryPoolWidth(): number {
  return Math.max(1, Math.min(4, availableCores()))
}

export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length)
  const width = Math.min(items.length, Math.max(1, Math.floor(limit)))
  let next = 0
  let failed = false
  async function worker(): Promise<void> {
    while (!failed && next < items.length) {
      const index = next++
      try {
        results[index] = await fn(items[index]!, index)
      } catch (error) {
        failed = true
        throw error
      }
    }
  }
  await Promise.all(Array.from({ length: width }, worker))
  return results
}
