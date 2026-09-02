
import { writeFileSync } from 'node:fs'
import { isEnvTruthy } from '../envUtils.js'
import { registerCleanup } from '../cleanupRegistry.js'
import { flagEnv } from '../../substrate/flagRegistry.js'

let latched: boolean | null = null

export function fluxProbeEnabled(): boolean {
  if (latched === null) {
    latched = isEnvTruthy(flagEnv('MERCURY_FLUX_PROBE'))
    if (latched) armProbeTee()
  }
  return latched
}

let teeArmed = false
let teeWritten = false
function writeProbeTee(path: string): void {
  if (teeWritten) return
  const dump = fluxProbeDump()
  if (dump.allMarks.length === 0 && dump.frames.total === 0) return
  teeWritten = true
  try {
    writeFileSync(path, JSON.stringify(dump))
  } catch {
  }
}
function armProbeTee(): void {
  const path = flagEnv('MERCURY_FLUX_PROBE_TEE')
  if (!path || teeArmed) return
  teeArmed = true
  process.once('SIGTERM', () => writeProbeTee(path))
  process.once('SIGHUP', () => writeProbeTee(path))
  registerCleanup(async () => writeProbeTee(path))
  process.on('exit', () => writeProbeTee(path))
}

const RING_CAP = 8192

export type FluxMark = { t: number; k: string; v: number }

const marks: FluxMark[] = []
let markAt = 0
const counters = new Map<string, number>()
const frameDur: number[] = []
let frameAt = 0
let framesTotal = 0
let longestFrameMs = 0

export function fluxCount(k: string, by = 1): void {
  if (!fluxProbeEnabled()) return
  counters.set(k, (counters.get(k) ?? 0) + by)
}

export function fluxMark(k: string, v = 0): void {
  if (!fluxProbeEnabled()) return
  const m: FluxMark = { t: performance.now(), k, v }
  if (marks.length < RING_CAP) marks.push(m)
  else {
    marks[markAt] = m
    markAt = (markAt + 1) % RING_CAP
  }
}

export function fluxWhy(
  region: string,
  prev: { current: Record<string, unknown> | null },
  read: () => Record<string, unknown>,
): void {
  if (!fluxProbeEnabled()) return
  const next = read()
  const before = prev.current
  prev.current = next
  if (before === null) {
    fluxMark(`why:${region}:mount`)
    return
  }
  let moved = 0
  for (const key of Object.keys(next)) {
    if (!Object.is(next[key], before[key])) {
      fluxMark(`why:${region}:${key}`)
      moved++
    }
  }
  if (moved === 0) fluxMark(`why:${region}:none`)
}

export function fluxFrame(durationMs: number, patches: number): void {
  if (!fluxProbeEnabled()) return
  framesTotal++
  if (durationMs > longestFrameMs) longestFrameMs = durationMs
  if (frameDur.length < RING_CAP) frameDur.push(durationMs)
  else {
    frameDur[frameAt] = durationMs
    frameAt = (frameAt + 1) % RING_CAP
  }
  if (patches > 0) fluxCount('patches', patches)
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)
  return sorted[Math.max(0, idx)]!
}

export type FluxSummary = {
  enabled: boolean
  counters: Record<string, number>
  frames: { total: number; window: number; p50: number; p95: number; p99: number; maxMs: number }
  recentMarks: FluxMark[]
}

export function fluxSummary(): FluxSummary {
  const sorted = [...frameDur].sort((a, b) => a - b)
  const recent =
    marks.length < RING_CAP ? [...marks] : [...marks.slice(markAt), ...marks.slice(0, markAt)]
  return {
    enabled: fluxProbeEnabled(),
    counters: Object.fromEntries(counters),
    frames: {
      total: framesTotal,
      window: frameDur.length,
      p50: percentile(sorted, 50),
      p95: percentile(sorted, 95),
      p99: percentile(sorted, 99),
      maxMs: longestFrameMs,
    },
    recentMarks: recent.slice(-64),
  }
}

export type FluxProbeDump = FluxSummary & {
  allMarks: FluxMark[]
  epochMinusPerfNow: number
}

export function fluxProbeDump(): FluxProbeDump {
  const all =
    marks.length < RING_CAP ? [...marks] : [...marks.slice(markAt), ...marks.slice(0, markAt)]
  return {
    ...fluxSummary(),
    allMarks: all,
    epochMinusPerfNow: Date.now() - performance.now(),
  }
}

export function __fluxProbeResetForTest(): void {
  latched = null
  marks.length = 0
  markAt = 0
  counters.clear()
  frameDur.length = 0
  frameAt = 0
  framesTotal = 0
  longestFrameMs = 0
}
