#!/usr/bin/env bun
import { readFileSync } from 'node:fs'

const files = process.argv.slice(2)
if (files.length === 0) {
  console.log('Usage: bun scripts/bench/bench-tool-batching.ts <stream-json-file> [<interval-log> ...]')
  console.log('Reports observed tool calls per assistant message and measured overlap; makes no provider calls and applies no performance threshold.')
  process.exit(0)
}
for (const file of files) {
  const rows = readFileSync(file, 'utf8').split('\n').filter(line => line.trim() !== '').map(line => JSON.parse(line))
  const messages = new Map<string, Set<string>>()
  const intervals = new Map<string, Array<[number, number]>>()
  for (const row of rows) {
    if (row.type === 'assistant' && !row.parent_tool_use_id) {
      const id = row.message?.id
      if (typeof id !== 'string') throw new Error(`An assistant message has no provider id in ${file}`)
      let calls = messages.get(id)
      if (calls === undefined) {
        calls = new Set()
        messages.set(id, calls)
      }
      for (const block of row.message.content ?? []) if (block.type === 'tool_use') calls.add(block.id)
    }
    if (typeof row.tool === 'string' && typeof row.start === 'number' && typeof row.end === 'number') {
      if (row.end < row.start) throw new Error(`A tool interval ends before it starts in ${file}`)
      const samples = intervals.get(row.tool) ?? []
      samples.push([row.start, row.end])
      intervals.set(row.tool, samples)
    }
  }
  const counts = [...messages.values()].map(calls => calls.size)
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
  if (counts.length === 0 && intervals.size === 0) throw new Error(`No assistant messages or measured intervals in ${file}`)
  console.log(JSON.stringify({
    file,
    toolsPerAssistantMessage: counts,
    toolCalls: counts.reduce((sum, count) => sum + count, 0),
    toolBearingMessages: bearing.length,
    medianToolsPerToolBearingMessage: bearing.length === 0 ? null : (bearing[Math.floor((bearing.length - 1) / 2)]! + bearing[Math.floor(bearing.length / 2)]!) / 2,
    overlap,
  }))
}
