
import { stringWidth } from './stringWidth.js'

const CACHE_LIMIT = 4096
const cache = new Map<string, number>()

export function lineWidth(line: string): number {
  const known = cache.get(line)
  if (known !== undefined) return known
  return remember(line, stringWidth(line))
}

function remember(line: string, width: number): number {
  if (cache.size >= CACHE_LIMIT) cache.clear()
  cache.set(line, width)
  return width
}
