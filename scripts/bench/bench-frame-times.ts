#!/usr/bin/env bun
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const directories = process.argv.slice(2)
if (directories.length === 0 || directories.includes('--help')) {
  console.log('Usage: bun scripts/bench/bench-frame-times.ts <capture-directory> [...]')
  console.log('Reads frames.jsonl, samples.jsonl and meta.json. Reports observed frame times without a performance threshold or provider calls.')
  process.exit(0)
}
const rowsOf = (file: string): any[] => readFileSync(file, 'utf8').split('\n').filter(line => line.trim()).map(line => JSON.parse(line))
const percentile = (sorted: number[], q: number): number | null => {
  if (sorted.length === 0) return null
  const position = q * (sorted.length - 1)
  const low = Math.floor(position)
  const index = position - low === 0.5 && low % 2 === 0 ? low : Math.round(position)
  return sorted[index]!
}
const runs = directories.map(directory => {
  const meta = JSON.parse(readFileSync(join(directory, 'meta.json'), 'utf8'))
  if (meta.exit_status !== 0) throw new Error(`The capture did not exit cleanly: ${directory}`)
  const samples = rowsOf(join(directory, 'samples.jsonl'))
    .filter(row => Number.isFinite(row.cockpit?.cputime_s) && Number.isFinite(row.wall))
    .map(row => ({ cpu: row.cockpit.cputime_s as number, wall: row.wall as number }))
    .sort((a, b) => a.cpu - b.cpu || a.wall - b.wall)
  if (samples.length === 0) throw new Error(`The capture has no CPU-time samples: ${directory}`)
  const start = meta.phase_wall?.idle
  const end = meta.phase_wall?.exit ?? meta.ended_at
  if (!Number.isFinite(start) || !Number.isFinite(end)) throw new Error(`Missing interactive interval: ${directory}`)
  const wallAt = (cpu: number): number => {
    if (cpu <= samples[0]!.cpu) return samples[0]!.wall
    for (let i = 1; i < samples.length; i++) {
      const a = samples[i - 1]!
      const b = samples[i]!
      if (a.cpu <= cpu && cpu <= b.cpu) return a.cpu === b.cpu ? a.wall : a.wall + (b.wall - a.wall) * (cpu - a.cpu) / (b.cpu - a.cpu)
    }
    return samples.at(-1)!.wall
  }
  const frames = rowsOf(join(directory, 'frames.jsonl'))
  if (frames.length === 0 || frames.some(frame => !Number.isFinite(frame.durationMs) || !Number.isFinite(frame.cpu?.user) || !Number.isFinite(frame.cpu?.system))) throw new Error(`Missing frame timing data: ${directory}`)
  const leg = frames.filter(frame => {
    const wall = wallAt((frame.cpu.user + frame.cpu.system) / 1e6)
    return wall >= start + 1 && wall < end - 1
  })
  const stats = (selected: any[]) => {
    const durations = selected.map(frame => frame.durationMs as number).sort((a, b) => a - b)
    const writes = selected.map(frame => frame.phases?.write).filter(Number.isFinite) as number[]
    return { frames: durations.length, p50: percentile(durations, 0.5), p95: percentile(durations, 0.95), p99: percentile(durations, 0.99), max: durations.at(-1) ?? null, maxWriteMs: writes.length > 0 ? Math.max(...writes) : null }
  }
  return { directory, initialLoad: meta.loadavg_at_start ?? null, intervalSeconds: end - start, all: stats(frames), leg: stats(leg) }
})
console.log(JSON.stringify({ samples: runs.length, runs }, null, 2))
