import { availableCores } from './availableCores.js'
import { notBuilt } from '../pi/holes.js'

export function discoveryPoolWidth(): number {
  return Math.max(1, Math.min(4, availableCores()))
}

export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  return notBuilt('src/utils/concurrency.ts:8')
}
