import { formatFileSize } from './format.js'

let perf: Performance | undefined

export function getPerformance(): Performance {
  return perf ??= globalThis.performance
}

export function formatMs(ms: number): string {
  return ms.toFixed(3)
}

export type MemorySnapshot = { heapUsed: number; rss: number }

export function formatTimelineLine(
  totalMs: number,
  deltaMs: number,
  name: string,
  memory: MemorySnapshot | undefined,
  totalPad: number,
  deltaPad: number,
  extra?: string,
): string {
  const total = `+${formatMs(totalMs)}ms`.padStart(totalPad)
  const delta = `+${formatMs(deltaMs)}ms`.padStart(deltaPad)
  const sizes = memory ? `  [rss ${formatFileSize(memory.rss)}, heap ${formatFileSize(memory.heapUsed)}]` : ''
  return `[${total}] (${delta}) ${name}${extra ?? ''}${sizes}`
}
