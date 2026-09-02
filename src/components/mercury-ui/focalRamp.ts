// ============================================================================
//  mercury-ui/focalRamp.ts — the grapheme-aware, cell-width-safe text ramp
//  (CN-08; promoted to the kit by its second live consumer, CN-10;
//  CONTINUOUS by design).
//
//  Splits text into grapheme clusters (Intl.Segmenter — a combining mark or a
//  VS16 sequence is never split from its base) and advances the sample column
//  by displayWidth(cluster), so a wide (CJK/2-cell) glyph is sampled at its
//  TRUE cells and column math never drifts. Each cluster samples the ramp at
//  its center cell; adjacent same-color clusters merge into one segment.
//
//  SAMPLING: piecewise-linear sRGB interpolation between adjacent
//  stops — u = (offsetCells + centerCell) / totalLogicalCells, mapped to
//  u·(stops-1) = segment index + local t, channels rounded to bytes. sRGB on
//  purpose (ruling R1): the stops sit on the family's own accent→ink
//  derivation line (deriveAccentSoft 0.4 / deriveFocalRamp 0.7,
//  mercuryTokens.ts), so lerping IS walking that derivation line at cell
//  resolution and per-channel monotonicity holds by construction. A sample
//  landing exactly on a stop returns the stop string verbatim (endpoint
//  exactness); the old floor-bucket law is absent (it painted categorical
//  blocks — the splash's three-flat-blocks defect, D1).
//
//  Stops are PALETTE ROLES — tokens.focalRamp (mercuryTokens.ts, derived
//  beside deriveAccentSoft). A single-stop ramp (light/daltonized/ansi, the
//  reduced-colour law) collapses to ONE flat segment. A ramp with ANY
//  unparseable stop (named/ansi colours) samples the NEAREST stop verbatim —
//  this module never invents a hue it wasn't handed.
//
//  BOUNDS — the ramp is an IDENTITY treatment with a CLOSED consumer set
// (censused by scripts/visual-contract/prove-focal-ramp.ts). Identity moments:
//  the wordmark family (Wordmark/BigWordmark here in the kit + the baked
//  splash word and its selected launcher row, mirrored by
//  scripts/splash/bake-ramp.mjs), and — by operator ruling — the
//  MAIN HEADERS (the ProductLockup `Mercury — VIEW` title run; the concourse
//  `MERCURY — SESSION CONCOURSE` lockup, theme-aware since) plus
//  the concourse header critter's bloom glow (CritterArt glowToward — the
//  art-cell expression of the same family). Never status/failure copy, never
//  body text; reduced-colour families collapse each surface to
//  its pre-ruling flat presentation. A new consumer is a bounds change:
// rule it into the census deliberately, with its why.
//
//  MOTION (operator ruling, amending the
//  "no animation" bound): identity ramps carry ONE sanctioned motion — the
//  bounded GREETING SHIMMER. The `shimmer` opt boosts each in-band cell's
//  sample coordinate toward the ink stop (u' = u + boost·(1−u)), so every
//  animated frame stays ON the family's own derivation line — no foreign
//  hue can enter — and a null/absent phase (or any cell outside the band)
//  renders the settled sample byte-for-byte. Schedule + settle law:
//  utils/cockpit/greetingShimmer.ts; React consumer: useGreetingShimmer.ts.
//
//  PARSE-ONCE: stops parse once per ramp, not once per cell per
//  render — a WeakMap keyed on the stops array identity (tokens are memoized
//  frozen objects, so the app path is a permanent hit) with a small
//  string-keyed fallback for ad-hoc literals.
// ============================================================================

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

/** Sample the ramp at u ∈ [0,1] (clamped). Exact stop hits return the stop
 *  string verbatim; between stops, channels lerp and round to bytes. */
function sampleAt(stops: string[], parsed: Rgb[] | null, u: number): string {
  const n = stops.length
  const s = Math.min(1, Math.max(0, u)) * (n - 1)
  if (parsed === null) {
    // Unparseable ramp: nearest stop, verbatim — never an invented hue.
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

/** The bare continuous law at u ∈ [0,1] — the seam splash parity bakes
 *  against (scripts/splash/bake-ramp.mjs): exact stop hits verbatim,
 *  piecewise-linear sRGB between. Text callers use rampSegments; this is for
 *  fixture generation and provers that need the sample at a raw position. */
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
    /** The greeting-shimmer phase (useGreetingShimmer). Null/absent renders
     *  the settled ramp; with a phase, in-band cells sample AHEAD toward the
     *  ink stop while out-of-band cells stay byte-identical to settled.
     *  Coordinates are span cells (offsetCells included), so split walks
     *  sharing one totalCells shimmer at the same x. Unparseable ramps
     *  (named/ansi stops) never shimmer — nearest-stop verbatim stands. */
    shimmer?: ShimmerPhase | null
  },
): RampSegment[] {
  if (text.length === 0) return []
  const flat = stops[0] ?? ''
  if (stops.length <= 1) return [{ text, color: flat }]
  const clusters = [...segmenter.segment(text)].map(s => s.segment)
  const widths = clusters.map(c => displayWidth(c))
  const total = widths.reduce((a, b) => a + b, 0)
  // Zero-width input (lone combining marks) can't be sampled — flat accent.
  if (total === 0) return [{ text, color: flat }]
  const offset = opts?.offsetCells ?? 0
  // The logical span the ramp stretches across: by default the text's own
  // cells; callers sharing one ramp across a wider coordinate space (or a
  // slice of one) pass totalCells so same-x samples same-colour.
  const span = opts?.totalCells ?? offset + total
  const parsed = parsedStops(stops)
  // The shimmer boosts sample coordinates, which only means anything on a
  // parseable multi-stop ramp (an unparseable ramp snaps to nearest stops —
  // a moving band would strobe categorical blocks).
  const shimmer = parsed !== null ? (opts?.shimmer ?? null) : null
  const segments: RampSegment[] = []
  let col = 0
  for (let i = 0; i < clusters.length; i++) {
    const w = widths[i] ?? 0
    // A zero-width cluster rides its neighbour's sample (center of a
    // zero-wide span is its position).
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
