
import { shimmerBoostAt, type ShimmerPhase } from '../../utils/cockpit/greetingShimmer.js'
import { displayWidth } from './glyphs.js'

export type RampSegment = { text: string; color: string }

const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' })

type Rgb = [number, number, number]

const parsedByRef = new WeakMap<string[], Rgb[] | null>()
const parsedByKey = new Map<string, Rgb[] | null>()
const PARSED_KEY_CAP = 64

function parseHex(c: string): Rgb | null {
  const m = /^#([0-9a-fA-F]{2})([0-9a-fA-F]{2})([0-9a-fA-F]{2})$/.exec(c)
  return m ? [parseInt(m[1] ?? '', 16), parseInt(m[2] ?? '', 16), parseInt(m[3] ?? '', 16)] : null
}

function parsedStops(stops: string[]): Rgb[] | null {
  const byRef = parsedByRef.get(stops)
  if (byRef !== undefined) return byRef
  const key = stops.join('|')
  const byKey = parsedByKey.get(key)
  if (byKey !== undefined) {
    parsedByRef.set(stops, byKey)
    return byKey
  }
  let value: Rgb[] | null = []
  for (const s of stops) {
    const p = parseHex(s)
    if (!p) {
      value = null
      break
    }
    value.push(p)
  }
  parsedByRef.set(stops, value)
  if (parsedByKey.size >= PARSED_KEY_CAP) {
    const oldest = parsedByKey.keys().next().value
    if (oldest !== undefined) parsedByKey.delete(oldest)
  }
  parsedByKey.set(key, value)
  return value
}

function sampleAt(stops: string[], parsed: Rgb[] | null, u: number): string {
  const n = stops.length
  const s = Math.min(1, Math.max(0, u)) * (n - 1)
  if (parsed === null) {
    return stops[Math.min(n - 1, Math.round(s))] ?? stops[0] ?? ''
  }
  if (Number.isInteger(s)) return stops[s] ?? ''
  const i = Math.floor(s)
  const t = s - i
  const a = parsed[i] as Rgb
  const b = parsed[i + 1] as Rgb
  const ch = (x: number, y: number): string =>
    Math.max(0, Math.min(255, Math.round(x + (y - x) * t)))
      .toString(16)
      .padStart(2, '0')
  return `#${ch(a[0], b[0])}${ch(a[1], b[1])}${ch(a[2], b[2])}`
}

export function rampSampleAt(stops: string[], u: number): string {
  if (stops.length <= 1) return stops[0] ?? ''
  return sampleAt(stops, parsedStops(stops), u)
}

export function rampSegments(
  text: string,
  stops: string[],
  opts?: {
    offsetCells?: number
    totalCells?: number
    shimmer?: ShimmerPhase | null
  },
): RampSegment[] {
  if (text.length === 0) return []
  const flat = stops[0] ?? ''
  if (stops.length <= 1) return [{ text, color: flat }]
  const clusters = [...segmenter.segment(text)].map(s => s.segment)
  const widths = clusters.map(c => displayWidth(c))
  const total = widths.reduce((a, b) => a + b, 0)
  if (total === 0) return [{ text, color: flat }]
  const offset = opts?.offsetCells ?? 0
  const span = opts?.totalCells ?? offset + total
  const parsed = parsedStops(stops)
  const shimmer = parsed !== null ? (opts?.shimmer ?? null) : null
  const segments: RampSegment[] = []
  let col = 0
  for (let i = 0; i < clusters.length; i++) {
    const w = widths[i] ?? 0
    const center = col + (w > 0 ? w / 2 : 0)
    let u = (offset + center) / span
    if (shimmer !== null) {
      const boost = shimmerBoostAt(offset + center, shimmer)
      if (boost > 0) u = u + boost * (1 - u)
    }
    const color = span > 0 ? sampleAt(stops, parsed, u) : flat
    const last = segments[segments.length - 1]
    if (last && last.color === color) last.text += clusters[i]
    else segments.push({ text: clusters[i] ?? '', color })
    col += w
  }
  return segments
}
