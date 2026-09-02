
import { stringWidth } from './stringWidth.js'

const CACHE_LIMIT = 4096
const cache = new Map<string, number>()

export function lineWidth(line: string): number {
  const cached = cache.get(line)
  if (cached !== undefined) return cached
  const width = stringWidth(line)
  if (cache.size >= CACHE_LIMIT) {
    cache.clear()
  }
  cache.set(line, width)
  return width
}
