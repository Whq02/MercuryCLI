import { lineWidth } from './line-width-cache.js'

export default function measureText(
  text: string,
  maxWidth: number,
): { width: number; height: number } {
  if (text === '') return { width: 0, height: 0 }
  const wraps = Number.isFinite(maxWidth) && maxWidth > 0
  let width = 0
  let height = 0
  for (const line of text.split('\n')) {
    const cells = lineWidth(line)
    width = Math.max(width, cells)
    height += wraps && cells > 0 ? Math.ceil(cells / maxWidth) : 1
  }
  return { width, height }
}
