#!/usr/bin/env bun
import { readFileSync } from 'node:fs'
import { frameLines, isMainThread, isStep, isToolCall } from '../lib/rows.ts'

const files = process.argv.slice(2)
if (files.length === 0) {
  console.log('Usage: bun scripts/bench/bench-tool-batching.ts <rows-file> [<interval-log> ...]')
  console.log('Reports observed tool calls per model step and measured overlap; makes no provider calls and applies no performance threshold.')
  process.exit(0)
}
for (const file of files) {
  const rows = frameLines(readFileSync(file, 'utf8'))
  const steps = new Map<string, Set<string>>()
  const intervals = new Map<string, Array<[number, number]>>()
  const callsOf = (messageId: unknown): Set<string> => {
    if (typeof messageId !== 'string') throw new Error(`A model row has no message id in ${file}`)
    let calls = steps.get(messageId)
    if (calls === undefined) {
      calls = new Set()
      steps.set(messageId, calls)
    }
    return calls
  }
  for (const row of rows) {
    if (isMainThread(row) && isStep(row)) callsOf(row.message_id)
    if (isMainThread(row) && isToolCall(row)) callsOf(row.message_id).add(String(row.call_id))
    if (typeof row.tool === 'string' && typeof row.start === 'number' && typeof row.end === 'number') {
      if (row.end < row.start) throw new Error(`A tool interval ends before it starts in ${file}`)
      const samples = intervals.get(row.tool) ?? []
      samples.push([row.start, row.end])
      intervals.set(row.tool, samples)
    }
  }
  const counts = [...steps.values()].map(calls => calls.size)
  const bearing = counts.filter(count => count > 0).sort((a, b) => a - b)
  const overlap = Object.fromEntries([...intervals].map(([tool, samples]) => {
    const events = samples.flatMap(([start, end]) => [[start, 1], [end, -1]]).sort((a, b) => a[0]! - b[0]! || a[1]! - b[1]!)
    let active = 0
    let maximum = 0
    for (const [, change] of events) {
      active += change!
      maximum = Math.max(maximum, active)
    }
    return [tool, { calls: samples.length, spanMs: Math.max(...samples.map(sample => sample[1])) - Math.min(...samples.map(sample => sample[0])), maxConcurrent: maximum }]
  }))
  if (counts.length === 0 && intervals.size === 0) throw new Error(`No model steps or measured intervals in ${file}`)
  console.log(JSON.stringify({
    file,
    toolsPerStep: counts,
    toolCalls: counts.reduce((sum, count) => sum + count, 0),
    toolBearingSteps: bearing.length,
    medianToolsPerToolBearingStep: bearing.length === 0 ? null : (bearing[Math.floor((bearing.length - 1) / 2)]! + bearing[Math.floor(bearing.length / 2)]!) / 2,
    overlap,
  }))
}
