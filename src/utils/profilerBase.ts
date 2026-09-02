import { formatFileSize } from './format.js'


let perf: Performance | null = null

export function getPerformance(): Performance {
  if (!perf) perf = globalThis.performance
  return perf
}

export function formatMs(ms: number): string {
  return ms.toFixed(3)
}

export type MemorySnapshot = { rss: number; heapUsed: number }

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
  const memorySuffix = memory ? `  [rss ${formatFileSize(memory.rss)}, heap ${formatFileSize(memory.heapUsed)}]` : ''
  return `[${total}] (${delta}) ${name}${extra ?? ''}${memorySuffix}`
}
