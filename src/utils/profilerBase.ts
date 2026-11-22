import { notBuilt, type Unbuilt } from '../pi/holes.js'

export function getPerformance(): Performance {
  return notBuilt('src/utils/profilerBase.ts:6')
}

export function formatMs(ms: number): string {
  return notBuilt('src/utils/profilerBase.ts:11')
}

export type MemorySnapshot = Unbuilt

export function formatTimelineLine(
  totalMs: number,
  deltaMs: number,
  name: string,
  memory: MemorySnapshot | undefined,
  totalPad: number,
  deltaPad: number,
  extra?: string,
): string {
  return notBuilt('src/utils/profilerBase.ts:17')
}
