import { createReadStream } from 'node:fs'
import { createInterface } from 'node:readline'
import { profileJsonValues } from './profileJson.js'
import { parseV8Profile, parseSampleProfile } from './profileParse.js'
import type { ProfileReading } from './profileModel.js'

const relative = (path: (string | number)[]): (string | number)[] => path[0] === 'profile' ? path.slice(1) : path
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)

async function loadV8(file: string, signal: AbortSignal): Promise<ProfileReading | null> {
  const nodes: unknown[] = []
  let start: unknown, end: unknown, samples = 0, deltas = 0, hasSamples = false, hasDeltas = false, wrapped = false
  for await (const item of profileJsonValues(file, signal, path => {
    const p = relative(path)
    if (p.length === 1 && (p[0] === 'samples' || p[0] === 'timeDeltas')) return 'array'
    return (p.length === 2 && ['nodes', 'samples', 'timeDeltas'].includes(String(p[0]))) || (p.length === 1 && (p[0] === 'startTime' || p[0] === 'endTime'))
  })) {
    if (item.path[0] === 'profile' && !wrapped) { wrapped = true; nodes.length = 0; start = end = undefined; samples = deltas = 0; hasSamples = hasDeltas = false }
    if (wrapped && item.path[0] !== 'profile') continue
    const p = relative(item.path)
    if (p[0] === 'nodes' && p.length === 2) nodes.push(item.value)
    if (p[0] === 'startTime') start = item.value
    if (p[0] === 'endTime') end = item.value
    if (p[0] === 'samples') { if (p.length === 1) hasSamples = Array.isArray(item.value); else samples++ }
    if (p[0] === 'timeDeltas') { if (p.length === 1) hasDeltas = Array.isArray(item.value); else deltas++ }
  }
  const reading = parseV8Profile({ nodes, startTime: start, endTime: end })
  if (!reading || !hasSamples || !hasDeltas || samples === 0) return reading
  reading.weighting = 'sample/time-delta weights (streamed passes)'
  reading.samples = samples
  reading.quality.delete('Sample/time-delta pairs are unavailable; timing is estimated from hit counts, not measured per frame.')
  for (const node of reading.nodes.values()) node.self = 0
  if (samples !== deltas) reading.quality.add(`Sample/delta lengths differ (${samples}/${deltas}); only paired entries contribute time.`)
  const select = (name: string) => (path: (string | number)[]) => {
    const p = relative(path)
    return (wrapped ? path[0] === 'profile' : path[0] !== 'profile') && p.length === 2 && p[0] === name
  }
  const sampleValues = profileJsonValues(file, signal, select('samples'))
  const deltaValues = profileJsonValues(file, signal, select('timeDeltas'))
  try {
    for (let i = 0; i < Math.min(samples, deltas); i++) {
      signal.throwIfAborted()
      const [sample, delta] = await Promise.all([sampleValues.next(), deltaValues.next()])
      if (sample.done || delta.done) throw new Error('The profiler report changed while its samples were read.')
      const node = reading.nodes.get(Number(sample.value.value))
      const weight = delta.value.value
      if (!node) reading.quality.add('Samples naming missing nodes contribute no inferred time.')
      else if (!finite(weight) || weight <= 0) reading.quality.add('Nonpositive or invalid time deltas contribute no time.')
      else node.self += weight / 1000
    }
  } finally { await Promise.all([sampleValues.return(undefined), deltaValues.return(undefined)]) }
  return reading
}

export async function streamProfile(file: string, source: string, signal: AbortSignal): Promise<ProfileReading | null> {
  if (/\.cpuprofile$/i.test(source)) {
    try { return await loadV8(file, signal) } catch (error) { if (error instanceof SyntaxError) return null; throw error }
  }
  if (!/\.sample\.txt$/i.test(source)) return null
  const stream = createReadStream(file, { encoding: 'utf8', signal })
  const lines = createInterface({ input: stream, crlfDelay: Infinity })
  const report: string[] = []
  let graph = false
  try {
    for await (const line of lines) {
      signal.throwIfAborted()
      if (/^Analysis of sampling /.test(line)) report.push(line)
      if (/^Call graph:/.test(line)) { graph = true; report.push(line); continue }
      if (graph && /^\S/.test(line) && line.trim() !== '') break
      if (graph && /^([\s+|!:]*)(\d+)\s+(.+)$/.test(line)) report.push(line)
    }
  } finally { lines.close(); stream.destroy() }
  return parseSampleProfile(report.join('\n'))
}
