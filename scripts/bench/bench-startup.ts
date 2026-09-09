#!/usr/bin/env bun
import { readFileSync } from 'node:fs'

const files = process.argv.slice(2)
if (files.length === 0 || files.includes('--help')) {
  console.log('Usage: bun scripts/bench/bench-startup.ts <capture-meta.json> [...]')
  console.log('Reports observed startup milestones, sample counts and median/max times from terminal captures. Makes no provider calls and applies no performance threshold.')
  process.exit(0)
}
const runs = files.map(file => {
  const capture = JSON.parse(readFileSync(file, 'utf8'))
  if (capture.exit_status !== 0) throw new Error(`The capture did not exit cleanly: ${file}`)
  const rows = capture.milestones?.rows?.filter((row: any) => row.pid === capture.pid) ?? []
  const at = (name: string): number => {
    const value = rows.find((row: any) => row.milestone === name)?.atMs
    if (!Number.isFinite(value)) throw new Error(`Missing ${name} milestone: ${file}`)
    return value
  }
  if (!Number.isFinite(capture.started_at)) throw new Error(`Missing capture start time: ${file}`)
  const runtime = at('runtime-entry')
  return {
    file,
    spawnToRuntimeMs: runtime - capture.started_at * 1000,
    firstFrameMs: at('first-frame') - runtime,
    inputLiveMs: at('input-live') - runtime,
    spawnToFirstFrameMs: at('first-frame') - capture.started_at * 1000,
    initialLoad: capture.loadavg_at_start ?? null,
  }
})
const summary = Object.fromEntries(['spawnToRuntimeMs', 'firstFrameMs', 'inputLiveMs', 'spawnToFirstFrameMs'].map(key => {
  const values = runs.map(run => run[key as keyof typeof run] as number).sort((a, b) => a - b)
  return [key, {
    median: (values[Math.floor((values.length - 1) / 2)]! + values[Math.floor(values.length / 2)]!) / 2,
    max: values.at(-1),
  }]
}))
console.log(JSON.stringify({ samples: runs.length, runs, summary }, null, 2))
