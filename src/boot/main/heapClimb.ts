import { getHeapStatistics } from 'node:v8'
import { logForDebugging } from '../../platform/logs/debugLog.js'

const HEAP_STEP_MB = 500
const MB = 1024 * 1024

let stepsPassed = 0

export function heapClimbLine(usedBytes: number, limitBytes: number, passed: number): { steps: number; line: string } | null {
  const usedMb = Math.floor(usedBytes / MB)
  const steps = Math.floor(usedMb / HEAP_STEP_MB)
  if (steps <= passed) return null
  return {
    steps,
    line: `[heap] used heap passed ${steps * HEAP_STEP_MB} MB: ${usedMb} MB used of a ${Math.floor(limitBytes / MB)} MB limit`,
  }
}

export function noteHeapClimb(): void {
  const heap = getHeapStatistics()
  const climb = heapClimbLine(heap.used_heap_size, heap.heap_size_limit, stepsPassed)
  if (climb === null) return
  stepsPassed = climb.steps
  logForDebugging(climb.line, { level: 'warn' })
}
