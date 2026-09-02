// Memoised per-line display width. During streaming, completed lines are
// immutable, and re-measuring hundreds of unchanged lines per token
// dominates the frame; the cache turns those into lookups.

import { stringWidth } from './stringWidth.js'

const CACHE_LIMIT = 4096
const cache = new Map<string, number>()

export function lineWidth(line: string): number {
  const cached = cache.get(line)
  if (cached !== undefined) return cached
  const width = stringWidth(line)
  if (cache.size >= CACHE_LIMIT) {
    // Wholesale clear on overflow: it repopulates within one frame.
    cache.clear()
  }
  cache.set(line, width)
  return width
}
