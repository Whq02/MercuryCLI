import type { ProfileNode, ProfileReading } from './profileModel.js'

type V8Node = { id?: unknown; callFrame?: { functionName?: unknown; url?: unknown; lineNumber?: unknown; columnNumber?: unknown }; children?: unknown; hitCount?: unknown }
const object = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)

export function parseV8Profile(value: unknown): ProfileReading | null {
  if (!object(value)) return null
  const raw = object(value.profile) ? value.profile : value
  if (!Array.isArray(raw.nodes) || !finite(raw.startTime) || !finite(raw.endTime)) return null
  const reading: ProfileReading = { format: 'V8', unit: 'ms', duration: (raw.endTime - raw.startTime) / 1000, samples: 0, weighting: 'sample/time-delta weights', nodes: new Map(), quality: new Set() }
  if (reading.duration! < 0) { reading.duration = null; reading.quality.add('End time precedes start time; duration is unknown.') }
  for (const value of raw.nodes) {
    const node = value as V8Node
    if (!object(value) || !finite(node.id) || !object(node.callFrame) || typeof node.callFrame.functionName !== 'string') return null
    const frame = node.callFrame
    if (reading.nodes.has(node.id)) reading.quality.add('Duplicate node ids use their first recorded definition.')
    else reading.nodes.set(node.id, {
      id: node.id, frame: { function: String(frame.functionName), file: typeof frame.url === 'string' ? frame.url : '', line: finite(frame.lineNumber) && frame.lineNumber >= 0 ? frame.lineNumber + 1 : null, column: finite(frame.columnNumber) && frame.columnNumber >= 0 ? frame.columnNumber + 1 : null, module: '' },
      children: Array.isArray(node.children) ? node.children.filter(finite) : [], self: 0, hits: finite(node.hitCount) && node.hitCount > 0 ? node.hitCount : 0, thread: '',
    })
  }
  if (!reading.nodes.size) return null
  const samples = Array.isArray(raw.samples) ? raw.samples : null
  const deltas = Array.isArray(raw.timeDeltas) ? raw.timeDeltas : null
  if (samples && samples.length > 0 && deltas) {
    reading.samples = samples.length
    if (samples.length !== deltas.length) reading.quality.add(`Sample/delta lengths differ (${samples.length}/${deltas.length}); only paired entries contribute time.`)
    for (let i = 0; i < Math.min(samples.length, deltas.length); i++) {
      const node = reading.nodes.get(samples[i])
      const delta = deltas[i]
      if (!node) reading.quality.add('Samples naming missing nodes contribute no inferred time.')
      else if (!finite(delta) || delta <= 0) reading.quality.add('Nonpositive or invalid time deltas contribute no time.')
      else node.self += delta / 1000
    }
  } else {
    reading.weighting = 'hit-count approximation (duration divided by total hits)'
    reading.samples = [...reading.nodes.values()].reduce((sum, node) => sum + node.hits, 0)
    const interval = reading.samples ? (reading.duration ?? 0) / reading.samples : 0
    for (const node of reading.nodes.values()) node.self = node.hits * interval
    reading.quality.add('Sample/time-delta pairs are unavailable; timing is estimated from hit counts, not measured per frame.')
  }
  return reading
}

function symbolDisplay(symbol: string): string {
  if (symbol.startsWith('_R')) {
    let at = 2
    const parts: string[] = []
    while (at < symbol.length) {
      const marker = symbol[at]!
      if (marker === 's' || marker === 'B') {
        const end = symbol.indexOf('_', at + 1)
        if (end < 0) return symbol
        at = end + 1
        continue
      }
      if (/\d/.test(marker)) {
        const digits = /^\d+/.exec(symbol.slice(at))![0]
        at += digits.length
        const length = Number(digits)
        if (symbol[at] === '_') at++
        if (!Number.isSafeInteger(length) || length < 1 || at + length > symbol.length) return symbol
        parts.push(symbol.slice(at, at + length))
        at += length
      } else at++
    }
    return parts.length ? parts.join('::') : symbol
  }
  const legacy = /^(?:_?ZN)(.*)E$/.exec(symbol)
  if (!legacy) return symbol
  let rest = legacy[1]!, parts: string[] = []
  while (rest) {
    const size = /^(\d+)/.exec(rest)
    if (!size) return symbol
    const length = Number(size[1])
    rest = rest.slice(size[1]!.length)
    if (length <= 0 || length > rest.length) return symbol
    const part = rest.slice(0, length)
    rest = rest.slice(length)
    if (!/^h[0-9a-f]{16}$/.test(part)) parts.push(part)
  }
  return parts.join('::') || symbol
}

export function parseSampleProfile(text: string): ProfileReading | null {
  if (!/^Analysis of sampling /m.test(text) || !/^Call graph:/m.test(text)) return null
  const reading: ProfileReading = { format: 'macOS sample', unit: 'samples', duration: null, samples: 0, weighting: 'inclusive samples minus immediate children; known wait leaves excluded from on-CPU estimate', nodes: new Map(), quality: new Set() }
  const interval = /every\s+([\d.]+)\s+millisecond/.exec(text)
  if (interval) {
    reading.interval = Number(interval[1])
    reading.quality.add(`Sampling interval: ${interval[1]} ms; sample counts are not verified scheduler time.`)
  }
  reading.quality.add('Symbol display is best-effort; the original symbol and module remain authoritative.')
  let graph = false, thread = '', id = 0, heading = -1
  const stack: { depth: number; node: ProfileNode }[] = []
  for (const line of text.split(/\r?\n/)) {
    if (/^Call graph:/.test(line)) { graph = true; continue }
    if (!graph) continue
    if (/^\S/.test(line) && line.trim() !== '') break
    const match = /^([\s+|!:]*)(\d+)\s+(.+)$/.exec(line)
    if (!match) continue
    const count = Number(match[2]), body = match[3]!
    if (/^(?:Thread_|Thread |DispatchQueue_)/.test(body) && (heading < 0 || match[1]!.length === heading)) { heading = match[1]!.length; thread = body; stack.length = 0; continue }
    const module = /\s+\(in ([^)]+)\)/.exec(body)
    const name = body.slice(0, module?.index ?? body.length).replace(/\s+\+\s+\d+.*$|\s+\[0x[0-9a-f]+\].*$/i, '').trim()
    const node: ProfileNode = { id: ++id, frame: { function: name, display: symbolDisplay(name), module: module?.[1] ?? '', file: '', line: null, column: null }, self: count, hits: count, children: [], thread }
    const depth = match[1]!.length
    while (stack.length && stack[stack.length - 1]!.depth >= depth) stack.pop()
    const parent = stack[stack.length - 1]
    if (parent) { parent.node.children.push(node.id); parent.node.self -= count }
    else reading.samples += count
    reading.nodes.set(node.id, node)
    stack.push({ depth, node })
  }
  for (const node of reading.nodes.values()) if (node.self < 0) { node.self = 0; reading.quality.add('Child samples exceed their parent; negative self estimates were omitted.') }
  return reading.nodes.size ? reading : null
}
