import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import * as v8 from 'node:v8'

import { getSessionId } from '../bootstrap/state.js'
import { MERCURY_VERSION } from '../constants/product.js'
import { logForDebugging } from './debug.js'
import { errorMessage } from './errors.js'
import { getDesktopPath } from './file.js'
import { getFsImplementation } from './fsOperations.js'
import { logError } from './log.js'
import { jsonStringify } from './slowOperations.js'

/**
 * Heap snapshot + memory diagnostics capture for the heap-dump command.
 * Diagnostics are captured BEFORE the snapshot: serialisation can crash on
 * very large heaps (the numbers are still valuable), and taking the
 * snapshot itself allocates and would skew them.
 */

export type HeapDumpResult = {
  success: boolean
  heapPath?: string
  diagPath?: string
  error?: string
}

/** Member names are the keys of the JSON file users are asked to share. */
export type MemoryDiagnostics = {
  timestamp: string
  sessionId: string
  trigger: 'manual' | 'auto-1.5GB'
  dumpNumber: number
  uptimeSeconds: number
  memoryUsage: { heapUsed: number; heapTotal: number; external: number; arrayBuffers: number; rss: number }
  memoryGrowthRate: { bytesPerSecond: number; mbPerHour: number }
  v8HeapStats: {
    heapSizeLimit: number
    mallocedMemory: number
    peakMallocedMemory: number
    numberOfDetachedContexts: number
    numberOfNativeContexts: number
  }
  v8HeapSpaces?: Array<{ spaceName: string; spaceSize: number; spaceUsedSize: number; spaceAvailableSize: number; physicalSpaceSize: number }>
  resourceUsage: { maxRSS: number; userCPUTime: number; systemCPUTime: number }
  activeHandles: number
  activeRequests: number
  openFileDescriptors?: number
  analysis: { potentialLeaks: string[]; recommendation: string }
  smapsRollup?: string
  platform: string
  nodeVersion: string
  mercuryVersion: string
}

const HANDLE_THRESHOLD = 100
const GROWTH_MB_PER_HOUR_THRESHOLD = 100
const FD_THRESHOLD = 500

function countActive(accessor: '_getActiveHandles' | '_getActiveRequests'): number {
  const fn = (process as unknown as Record<string, () => unknown[]>)[accessor]
  try {
    return typeof fn === 'function' ? fn.call(process).length : 0
  } catch {
    return 0
  }
}

export async function captureMemoryDiagnostics(
  trigger: 'manual' | 'auto-1.5GB',
  dumpNumber: number = 0,
): Promise<MemoryDiagnostics> {
  const uptimeSeconds = process.uptime()
  const memory = process.memoryUsage()
  const heap = v8.getHeapStatistics()
  let heapSpaces: MemoryDiagnostics['v8HeapSpaces']
  try {
    // The space enumeration is unavailable on the Bun runtime.
    heapSpaces = v8.getHeapSpaceStatistics().map(space => ({
      spaceName: space.space_name,
      spaceSize: space.space_size,
      spaceUsedSize: space.space_used_size,
      spaceAvailableSize: space.space_available_size,
      physicalSpaceSize: space.physical_space_size,
    }))
  } catch {
    heapSpaces = undefined
  }
  const usage = process.resourceUsage()
  let openFileDescriptors: number | undefined
  let smapsRollup: string | undefined
  if (process.platform === 'linux') {
    try {
      openFileDescriptors = readdirSync('/proc/self/fd').length
    } catch {
      openFileDescriptors = undefined
    }
    try {
      smapsRollup = readFileSync('/proc/self/smaps_rollup', 'utf8')
    } catch {
      smapsRollup = undefined
    }
  }
  const activeHandles = countActive('_getActiveHandles')
  const activeRequests = countActive('_getActiveRequests')
  // The growth rate is resident set over uptime — an average since process
  // start, not a windowed delta.
  const bytesPerSecond = uptimeSeconds > 0 ? memory.rss / uptimeSeconds : 0
  const mbPerHour = (bytesPerSecond * 3600) / (1024 * 1024)

  const potentialLeaks: string[] = []
  if (heap.number_of_detached_contexts > 0) {
    potentialLeaks.push(`${heap.number_of_detached_contexts} detached context(s)`)
  }
  if (activeHandles > HANDLE_THRESHOLD) {
    potentialLeaks.push(`${activeHandles} active handles (threshold ${HANDLE_THRESHOLD})`)
  }
  const nativeMemory = memory.rss - memory.heapUsed
  if (nativeMemory > memory.heapUsed) {
    potentialLeaks.push(`native memory ${nativeMemory} bytes exceeds heap used ${memory.heapUsed} bytes (points at native add-ons, not the engine heap)`)
  }
  if (mbPerHour > GROWTH_MB_PER_HOUR_THRESHOLD) {
    potentialLeaks.push(`growth rate ${mbPerHour.toFixed(1)} MB/hour (threshold ${GROWTH_MB_PER_HOUR_THRESHOLD})`)
  }
  if (openFileDescriptors !== undefined && openFileDescriptors > FD_THRESHOLD) {
    potentialLeaks.push(`${openFileDescriptors} open file descriptors (threshold ${FD_THRESHOLD})`)
  }
  const recommendation =
    potentialLeaks.length > 0
      ? `${potentialLeaks.length} potential leak indicator(s) found; see potentialLeaks for details.`
      : 'No obvious leak indicators; inspect the heap snapshot for retained objects.'

  return {
    timestamp: new Date().toISOString(),
    sessionId: getSessionId(),
    trigger,
    dumpNumber,
    uptimeSeconds,
    memoryUsage: {
      heapUsed: memory.heapUsed,
      heapTotal: memory.heapTotal,
      external: memory.external,
      arrayBuffers: memory.arrayBuffers,
      rss: memory.rss,
    },
    memoryGrowthRate: { bytesPerSecond, mbPerHour },
    v8HeapStats: {
      heapSizeLimit: heap.heap_size_limit,
      mallocedMemory: heap.malloced_memory,
      peakMallocedMemory: heap.peak_malloced_memory,
      numberOfDetachedContexts: heap.number_of_detached_contexts,
      numberOfNativeContexts: heap.number_of_native_contexts,
    },
    ...(heapSpaces ? { v8HeapSpaces: heapSpaces } : {}),
    resourceUsage: {
      // Peak resident set converted from kilobytes to bytes.
      maxRSS: usage.maxRSS * 1024,
      userCPUTime: usage.userCPUTime,
      systemCPUTime: usage.systemCPUTime,
    },
    activeHandles,
    activeRequests,
    ...(openFileDescriptors !== undefined ? { openFileDescriptors } : {}),
    analysis: { potentialLeaks, recommendation },
    ...(smapsRollup !== undefined ? { smapsRollup } : {}),
    platform: process.platform,
    nodeVersion: process.version,
    mercuryVersion: MERCURY_VERSION,
  }
}

const gigabytes = (bytes: number): string => (bytes / (1024 * 1024 * 1024)).toFixed(3)

async function writeSnapshot(heapPath: string): Promise<void> {
  const bun = (globalThis as { Bun?: { generateHeapSnapshot?: (format: string) => unknown; gc?: (force: boolean) => void } }).Bun
  if (bun?.generateHeapSnapshot) {
    // Written SYNCHRONOUSLY on purpose: an async write hands the
    // multi-hundred-megabyte payload to another thread and the runtime copies
    // it to do so. A forced collection follows to release it sooner.
    const snapshot = bun.generateHeapSnapshot('v8')
    writeFileSync(heapPath, typeof snapshot === 'string' ? snapshot : jsonStringify(snapshot), { mode: 0o600 })
    bun.gc?.(true)
    return
  }
  const fs = getFsImplementation()
  await pipeline(v8.getHeapSnapshot(), fs.createWriteStream(heapPath, { mode: 0o600 }))
}

export async function performHeapDump(
  trigger: 'manual' | 'auto-1.5GB' = 'manual',
  dumpNumber: number = 0,
): Promise<HeapDumpResult> {
  try {
    const diagnostics = await captureMemoryDiagnostics(trigger, dumpNumber)
    logForDebugging(
      `heapDump: heap used ${gigabytes(diagnostics.memoryUsage.heapUsed)} GB (captured in the snapshot); ` +
        `rss ${gigabytes(diagnostics.memoryUsage.rss)} GB, external ${gigabytes(diagnostics.memoryUsage.external)} GB (not captured)`,
    )
    const desktop = getDesktopPath()
    getFsImplementation().mkdirSync(desktop)
    const suffix = dumpNumber > 0 ? `-dump${dumpNumber}` : ''
    const base = `${getSessionId()}${suffix}`
    const heapPath = join(desktop, `${base}.heapsnapshot`)
    const diagPath = join(desktop, `${base}-diagnostics.json`)
    // Diagnostics first — cheap and unlikely to fail.
    writeFileSync(diagPath, jsonStringify(diagnostics, null, 2), { mode: 0o600 })
    await writeSnapshot(heapPath)
    return { success: true, heapPath, diagPath }
  } catch (err) {
    logError(err)
    return { success: false, error: errorMessage(err) }
  }
}
