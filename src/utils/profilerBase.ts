import { formatFileSize } from './format.js'

/**
 * Shared timing primitives for the three profilers: the lazily-acquired
 * high-resolution performance API, fixed-3 millisecond formatting, and the
 * one timeline line shape.
 */

let perf: Performance | null = null

/** Acquired only when profiling is on; shared process-wide. */
export function getPerformance(): Performance {
  if (!perf) perf = globalThis.performance
  return perf
}

export function formatMs(ms: number): string {
  return ms.toFixed(3)
}

export type MemorySnapshot = { rss: number; heapUsed: number }

/**
 * `[+<total>ms] (+<delta>ms) <name><extra?><memory?>` with each numeric field
 * sign-prefixed, unit-suffixed and left-padded to the caller's width so each
 * profiler aligns its own columns. (The turn profiler composes this shape
 * inline instead — it appends a severity marker where the memory suffix
 * goes.)
 */
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
