#!/usr/bin/env bun
// ============================================================================
//  scripts/visual-contract/prove-focal-ramp.ts — width-safety + role-derivation +
//  continuous-sampling laws for the focal ramp (CN-08/CN-11;
//  RF-01/RF-02).
//
//  §1 rampSegments (mercury-ui/focalRamp.ts): grapheme clusters are never
//     split (combining marks, VS16 sequences); wide glyphs advance the sample
//     column by their TRUE cells (the W+U+6F22 discriminator would sample
//     differently under naive length math); segments always reassemble the
//     input byte-exactly; single-stop ramps collapse flat; degenerate inputs
//     (empty, zero-width) stay safe.
//
//  §2 the role derivation (mercuryTokens.ts): the dark brand family carries
//     the 3-stop accent→bloom→ink-walk ramp (the crab's mid stop IS the
//     authored BELLY); light + ansi + daltonized families resolve to the
//     plain accent (the reduced-colour law); an unparseable accent collapses
//     flat rather than inventing a hue.
//
//  §3 the CONTINUOUS law (RF-1): piecewise-linear sRGB between adjacent
//     stops, verified against an independent oracle; exact stop hits return
//     the stop verbatim; per-channel monotonicity across the span for derived
//     ramps (the R1 by-construction law); the FROZEN continuity gates at
//     widths 7/42/53 (recorded BEFORE tuning: old bucket max adjacent per-channel step 64; gates
//     21/4/4) — and the rejected floor-bucket variant VIOLATES the gate
//     (that law turns this leg red, so it can never silently return);
//     parse-once-per-ramp caching proven mechanically; the shared-span
//     opts contract (offsetCells/totalCells) keeps same-x-same-colour.
//
//  §4 the BOUNDED identity set: the ramp's src consumer census. CN-08 bound
//     the ramp to the wordmark family (+ the baked splash, which mirrors the
//     law with no src import); the OPERATOR RULING expanded the
//     set to the MAIN HEADERS (the ProductLockup title run; the concourse
//     lockup at the FIXED jellyfish accent) and the concourse header
//     critter's bloom glow. The census pins the EXACT file set and each
//     surface's reduced-colour collapse — a new glow surface must be ruled
//     in HERE, deliberately, never landed silently.
//
//  Unicode is spelled as escapes throughout (the raw-control/raw-glyph law
//  for tool-authored sources).
// ============================================================================

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { rampSampleAt, rampSegments, type RampSegment } from '../../src/components/mercury-ui/focalRamp.ts'
import { displayWidth } from '../../src/components/mercury-ui/glyphs.ts'
import { BELLY, TERRA } from '../../src/components/mercuryPalette.ts'
import { deriveFocalRamp, resolveMercuryTokens } from '../../src/utils/mercuryTokens.ts'
import { checker } from '../engine-durability/harness.ts'

const t = checker()
const STOPS = ['#aa0000', '#bb1111', '#cc2222']
const joined = (segs: Array<{ text: string }>): string => segs.map(s => s.text).join('')

// ── the independent oracle: the continuous law, reimplemented ──────────────
const parse = (c: string): [number, number, number] => [
  parseInt(c.slice(1, 3), 16),
  parseInt(c.slice(3, 5), 16),
  parseInt(c.slice(5, 7), 16),
]
const oracle = (stops: string[], u: number): string => {
  const n = stops.length
  const s = Math.min(1, Math.max(0, u)) * (n - 1)
  if (Number.isInteger(s)) return stops[s] ?? ''
  const i = Math.floor(s)
  const frac = s - i
  const a = parse(stops[i] ?? '')
  const b = parse(stops[i + 1] ?? '')
  const ch = (x: number, y: number): string =>
    Math.max(0, Math.min(255, Math.round(x + (y - x) * frac)))
      .toString(16)
      .padStart(2, '0')
  return `#${ch(a[0], b[0])}${ch(a[1], b[1])}${ch(a[2], b[2])}`
}
/** Expected segments for an ASCII string: per-cell oracle samples, merged. */
const oracleAscii = (text: string, stops: string[]): string[] =>
  [...text].map((_, x) => oracle(stops, (x + 0.5) / text.length))
/** Per-cell colors of a segment list (ASCII corpora: 1 cell per char). */
const cells = (segs: RampSegment[]): string[] => segs.flatMap(s => [...s.text].map(() => s.color))
const maxStep = (colors: string[]): number => {
  let max = 0
  for (let i = 1; i < colors.length; i++) {
    const a = parse(colors[i - 1] ?? '')
    const b = parse(colors[i] ?? '')
    max = Math.max(max, Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]), Math.abs(a[2] - b[2]))
  }
  return max
}
// The FROZEN gates (recorded before any tuning): ceil(maxChannelRange/(W-1))+1 for the dark
// crab ramp (ranges R=11 G=115 B=107), and the old bucket law's measured max
// adjacent step the new law must stay strictly below.
const CONTINUITY_GATE: Record<number, number> = { 7: 21, 42: 4, 53: 4 }
const OLD_BUCKET_STEP = 64
/** The rejected floor-bucket law, kept as the discriminator variant: it must
 *  VIOLATE the continuity gate — if the gate ever loosens enough to admit
 *  it, this leg goes red. */
const oldBucketCells = (width: number, stops: string[]): string[] =>
  Array.from({ length: width }, (_, x) => {
    const idx = Math.min(stops.length - 1, Math.floor(((x + 0.5) / width) * stops.length))
    return stops[idx] ?? ''
  })

t.section('§1 — rampSegments: grapheme + cell-width safety')
{
  const ascii = rampSegments('Mercury', STOPS)
  t.check('ASCII reassembles byte-exactly', joined(ascii) === 'Mercury', JSON.stringify(ascii))
  t.check(
    'ASCII cell colors equal the oracle walk (continuous, not bucketed)',
    JSON.stringify(cells(ascii)) === JSON.stringify(oracleAscii('Mercury', STOPS)),
    cells(ascii).join(','),
  )
  t.check(
    'the 7-cell walk paints MORE than the 3 stop colors (no posterized blocks)',
    new Set(cells(ascii)).size > 3,
    `${new Set(cells(ascii)).size} distinct`,
  )

  t.check('empty input yields no segments', rampSegments('', STOPS).length === 0)

  const one = rampSegments('M', STOPS)
  t.check(
    'a 1-cell string samples the ramp CENTER — the exact mid stop, verbatim',
    one.length === 1 && one[0]?.text === 'M' && one[0]?.color === STOPS[1],
    JSON.stringify(one),
  )

  const combining = 'e\u0301\u0301' // base + two combining acutes: ONE cluster
  const comb = rampSegments(combining, STOPS)
  t.check(
    'combining marks never split from their base (one cluster, one segment)',
    comb.length === 1 && joined(comb) === combining,
    JSON.stringify(comb),
  )

  const vs16 = '\u2620\uFE0F' // U+2620 + VS16: one cluster
  const v = rampSegments(vs16, STOPS)
  t.check(
    'a VS16 sequence stays one cluster (never split)',
    v.length === 1 && joined(v) === vs16,
    JSON.stringify(v),
  )

  const wide = '\u30C6\u30B9\u30C8' // katakana TE-SU-TO: three 2-cell clusters
  t.check(
    'the substrate agrees the corpus glyphs are 2-cell',
    displayWidth('\u30C6') === 2 && displayWidth('\u6F22') === 2,
    `u30C6=${displayWidth('\u30C6')} u6F22=${displayWidth('\u6F22')}`,
  )
  const w = rampSegments(wide, STOPS)
  // Centers 1/3/5 of 6 → u = 1/6, 1/2, 5/6: the middle cluster hits the mid
  // stop EXACTLY (verbatim); the outer two are exact oracle lerps.
  t.check(
    'three wide clusters sample at TRUE cell centers (mid = exact stop hit)',
    w.length === 3 &&
      joined(w) === wide &&
      w[0]?.color === oracle(STOPS, 1 / 6) &&
      w[1]?.color === STOPS[1] &&
      w[2]?.color === oracle(STOPS, 5 / 6),
    JSON.stringify(w),
  )

  // The TRUE-CELL discriminator: 'W' + two 2-cell U+6F22 has cell centers
  // 0.5 / 2 / 4 of 5. Naive per-character math (total 3, centers 0.5/1.5/2.5)
  // samples u = 1/6, 1/2, 5/6 instead — different colors on every cluster.
  // This leg fails under length-based sampling.
  const two = ['#110000', '#002200']
  const d = rampSegments('W\u6F22\u6F22', two)
  const wantTrue = [oracle(two, 0.5 / 5), oracle(two, 2 / 5), oracle(two, 4 / 5)]
  const wantNaive = [oracle(two, 0.5 / 3), oracle(two, 1.5 / 3), oracle(two, 2.5 / 3)]
  t.check(
    'wide glyphs advance the sample column by TRUE cells (the discriminator)',
    d.length === 3 &&
      d.map(s => s.color).join(',') === wantTrue.join(',') &&
      wantTrue.join(',') !== wantNaive.join(','),
    `got ${d.map(s => s.color).join(',')} true ${wantTrue.join(',')} naive ${wantNaive.join(',')}`,
  )

  const flat = rampSegments('Mercury', ['#dd4444'])
  t.check(
    'a single-stop ramp collapses to ONE flat segment (reduced-colour law)',
    flat.length === 1 && flat[0]?.color === '#dd4444' && joined(flat) === 'Mercury',
    JSON.stringify(flat),
  )

  const zero = rampSegments('\u0301', STOPS)
  t.check(
    'a zero-width-only input renders flat instead of dividing by zero',
    zero.length === 1 && joined(zero) === '\u0301',
    JSON.stringify(zero),
  )
}

t.section('§2 — the role derivation (mercuryTokens)')
{
  const dark = resolveMercuryTokens('dark', TERRA)
  t.check(
    'dark family: 3 stops, accent first',
    dark.focalRamp.length === 3 && dark.focalRamp[0] === TERRA,
    dark.focalRamp.join(' '),
  )
  t.check(
    "the crab's mid stop IS the authored BELLY (AURORA coherence)",
    dark.focalRamp[1] === BELLY,
    `${dark.focalRamp[1]} vs ${BELLY}`,
  )
  t.check(
    'the ramp mid stop equals accentSoft (one bloom, never a second derivation)',
    dark.focalRamp[1] === dark.accentSoft,
    `${dark.focalRamp[1]} vs ${dark.accentSoft}`,
  )

  const nonCrab = resolveMercuryTokens('dark', '#7755EE')
  t.check(
    'a non-crab accent derives its OWN ramp (no crab pink)',
    nonCrab.focalRamp.length === 3 &&
      nonCrab.focalRamp[0] === '#7755EE' &&
      nonCrab.focalRamp[1] === nonCrab.accentSoft &&
      nonCrab.focalRamp[1] !== BELLY,
    nonCrab.focalRamp.join(' '),
  )

  for (const family of ['light', 'dark-ansi', 'dark-daltonized', 'light-daltonized'] as const) {
    const tk = resolveMercuryTokens(family, TERRA)
    t.check(
      `${family}: the ramp collapses to the plain accent`,
      tk.focalRamp.length === 1 && tk.focalRamp[0] === TERRA,
      tk.focalRamp.join(' '),
    )
  }

  t.check(
    'an unparseable accent collapses flat rather than inventing a hue',
    deriveFocalRamp('salmon', 'salmon', '#EDE8DD').length === 1,
    deriveFocalRamp('salmon', 'salmon', '#EDE8DD').join(' '),
  )
}

t.section('§3 — the continuous law (RF-1)')
{
  // Exact stop hits are verbatim: u=0 (a leading zero-width cluster samples
  // at column 0) and the exact mid landing (§1's 1-cell leg) both return the
  // stop STRING, byte-equal — no lowercase re-format of an authored role.
  const CASED = ['#DD4444', '#E58484', '#EDE8DD']
  const lead = rampSegments('\u0301M', CASED)
  t.check(
    'u=0 returns stops[0] verbatim (case preserved — endpoint exactness)',
    lead[0]?.color === CASED[0],
    JSON.stringify(lead),
  )

  // Per-stop midpoints: 'MERC' on 3 stops → s = 0.25/0.75/1.25/1.75, all
  // strictly inside a segment — exact oracle lerps, no snapping.
  const merc = rampSegments('MERC', STOPS)
  t.check(
    'quarter-point samples are exact piecewise lerps (oracle equality)',
    JSON.stringify(cells(merc)) === JSON.stringify(oracleAscii('MERC', STOPS)),
    cells(merc).join(','),
  )

  // Per-channel monotonicity across the span for DERIVED ramps (R1:
  // the stops sit on the family's own accent→ink derivation line, so the
  // walk is monotone per channel BY CONSTRUCTION — for every derived accent,
  // in whichever direction that channel walks toward the ink).
  for (const accent of [TERRA, '#7755EE', '#FF5A3A']) {
    const ramp = resolveMercuryTokens('dark', accent).focalRamp
    for (const W of [7, 42, 53]) {
      const colors = cells(rampSegments('M'.repeat(W), ramp))
      const first = parse(colors[0] ?? '')
      const last = parse(colors[colors.length - 1] ?? '')
      let monotone = true
      for (let c = 0; c < 3 && monotone; c++) {
        const dir = Math.sign((last[c] ?? 0) - (first[c] ?? 0))
        for (let i = 1; i < colors.length; i++) {
          const step = (parse(colors[i] ?? '')[c] ?? 0) - (parse(colors[i - 1] ?? '')[c] ?? 0)
          if (dir !== 0 && Math.sign(step) !== 0 && Math.sign(step) !== dir) {
            monotone = false
            break
          }
        }
      }
      t.check(`${accent} at W=${W}: per-channel monotone across the span`, monotone, colors.join(','))
    }
  }

  // The FROZEN continuity gates — and strictly below the old bucket jump.
  const darkRamp = resolveMercuryTokens('dark', TERRA).focalRamp
  for (const W of [7, 42, 53]) {
    const step = maxStep(cells(rampSegments('M'.repeat(W), darkRamp)))
    const gate = CONTINUITY_GATE[W] ?? 0
    t.check(
      `W=${W}: max adjacent per-channel step ${step} ≤ frozen gate ${gate} and < old bucket ${OLD_BUCKET_STEP}`,
      step <= gate && step < OLD_BUCKET_STEP,
      `step=${step}`,
    )
  }

  // The HISTORICAL VARIANT turns this proof red: the pre-RF-1 floor-bucket
  // law measures exactly the recorded 64 step and violates every gate.
  for (const W of [7, 42, 53]) {
    const step = maxStep(oldBucketCells(W, darkRamp))
    t.check(
      `old bucket law at W=${W} VIOLATES the gate (measures the recorded ${OLD_BUCKET_STEP})`,
      step === OLD_BUCKET_STEP && step > (CONTINUITY_GATE[W] ?? 0),
      `step=${step}`,
    )
  }

  // PARSE-ONCE, mechanically: mutate a stops array in place after first use —
  // a per-cell re-parse would see the mutation; the by-reference cache must
  // not. (Tokens arrays are frozen in production; this is the cache probe.)
  const probe = ['#000000', '#404040', '#808080']
  const before = JSON.stringify(rampSegments('MMMM', probe))
  probe[1] = '#ff0000'
  const after = JSON.stringify(rampSegments('MMMM', probe))
  t.check('stops parse once per ramp (in-place mutation is invisible)', before === after, after)
  // Determinism across identities: a FRESH array with the original content
  // rides the string-keyed fallback to byte-identical output.
  const fresh = JSON.stringify(rampSegments('MMMM', ['#000000', '#404040', '#808080']))
  t.check('equal-content stops give byte-identical segments', fresh === before, fresh)

  // A ramp with ANY unparseable stop samples the NEAREST stop verbatim.
  const namey = rampSegments('MMMM', ['salmon', '#ff0000'])
  t.check(
    'unparseable ramps sample nearest-stop verbatim (never an invented hue)',
    cells(namey).every(c => c === 'salmon' || c === '#ff0000') &&
      cells(namey)[0] === 'salmon' &&
      cells(namey)[3] === '#ff0000',
    JSON.stringify(namey),
  )

  // The shared-span contract: two half-row calls with offsetCells/totalCells
  // reproduce the unsplit walk cell-for-cell (same-x-same-colour).
  const full = cells(rampSegments('M'.repeat(42), darkRamp))
  const left = cells(rampSegments('M'.repeat(21), darkRamp, { offsetCells: 0, totalCells: 42 }))
  const right = cells(rampSegments('M'.repeat(21), darkRamp, { offsetCells: 21, totalCells: 42 }))
  t.check(
    'offsetCells/totalCells: split walks equal the unsplit walk (same-x-same-colour)',
    JSON.stringify([...left, ...right]) === JSON.stringify(full),
    `${left[20]} | ${right[0]} vs ${full[20]} | ${full[21]}`,
  )
}

t.section('§4 — the BOUNDED identity set')
{
  // The closed consumer set. WHY each file is an identity moment:
  //   assets.tsx      — Wordmark + BigWordmark (CN-10; RF-2) — the original
  //                     CN-08 bounds (the splash mirrors by bake, no import).
  //   components.tsx  — ProductLockup: the `Mercury — VIEW` main-header title
  //                     run (the identity
  //                     set includes the main headers).
  //   ConcourseHeader — the `MERCURY — SESSION CONCOURSE` lockup + the header
  //                     critter's bloom glow, at the SELECTED critter's
  //                     accent — same ruling.
  //   CritterArt      — the glow RENDERER seam: it receives the tokens-derived
  //                     bloom via glowToward and applies the ramp's collapse
  //                     gate contract; it derives nothing itself (the seam pin
  //                     below proves that mechanically).
  //   greetingShimmer.ts / useGreetingShimmer.ts — the GLOW greeting (operator
  //                     ruling, amending the no-motion bound): the
  //                     React-free schedule leaf + its ONE React owner. They
  //                     feed rampSegments' shimmer opt; neither samples a hue
  //                     of its own (§5 pins the settled fixed point).
  //   useSplashCoreAccent.ts — the boot-face accent bridge: resolves the
  //                     LIVE session tokens' focalRamp into the splash core's
  //                     family contract (GLOW: the boot screens follow the
  //                     selected critter) — a resolver hand-off, no sampling.
  // Updating this table is a deliberate bounds change — record the why above,
  // never widen the sweep or drop a pin to make a new consumer pass.
  const ALLOWED = new Set([
    'src/components/mercury-ui/assets.tsx',
    'src/components/mercury-ui/components.tsx',
    'src/components/concourse/ConcourseHeader.tsx',
    'src/components/mercury-ui/CritterArt.tsx',
    'src/utils/cockpit/greetingShimmer.ts',
    'src/components/mercury-ui/useGreetingShimmer.ts',
    'src/components/mercury-ui/useSplashCoreAccent.ts',
  ])
  const consumers: string[] = []
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name)
      if (statSync(full).isDirectory()) {
        if (name === 'node_modules') continue
        walk(full)
        continue
      }
      if (!/\.tsx?$/.test(name)) continue
      const rel = relative(process.cwd(), full).replaceAll('\\', '/')
      // The two owners define the law; everything else that touches
      // rampSegments/rampSampleAt or the focalRamp token CONSUMES it.
      if (rel === 'src/components/mercury-ui/focalRamp.ts' || rel === 'src/utils/mercuryTokens.ts') continue
      const src = readFileSync(full, 'utf8')
      if (/rampSegments|rampSampleAt|focalRamp/.test(src)) consumers.push(rel)
    }
  }
  walk(join(process.cwd(), 'src'))
  const strays = consumers.filter(f => !ALLOWED.has(f))
  t.check(
    'every src ramp consumer is a ruled identity moment (closed set)',
    strays.length === 0,
    strays.join(' ') || consumers.sort().join(' '),
  )
  const rotted = [...ALLOWED].filter(f => !consumers.includes(f))
  t.check(
    'every ruled identity file still consumes the ramp (no census rot)',
    rotted.length === 0,
    rotted.join(' ') || 'all live',
  )

  // Each expanded surface collapses on reduced-colour families to its
  // pre-ruling flat presentation (the CN-08 degradation law, per surface).
  const lockup = readFileSync('src/components/mercury-ui/components.tsx', 'utf8')
  t.check(
    'the ProductLockup title ramps ONLY where the family hosts the ramp (single-stop keeps the flat Wordmark + muted view)',
    /ramp\.length > 1 \?/.test(lockup),
    'gate pin',
  )
  const header = readFileSync('src/components/concourse/ConcourseHeader.tsx', 'utf8')
  // RE-CUT: the
  // concourse is THEME-AWARE. The lockup + glow now resolve at the SELECTED
  // critter's live accent, from the same selection owner the REPL uses
  // (useSessionAccent); the fixed-jellyfish literal is FORBIDDEN. The ramp
  // discipline itself is unchanged — one resolve, tokens-derived bloom.
  t.check(
    'the concourse lockup + glow resolve at the SELECTED critter accent (CR-3; SR-064 reversed)',
    /resolveMercuryTokens\(theme, sa\.accent\)/.test(header) &&
      /useSessionAccent\(\)/.test(header) &&
      !/JELLYFISH_HUE/.test(header),
    'accent pin',
  )
  t.check(
    'the concourse treatment collapses on single-stop families (flat info lockup; authored art)',
    /ramp\.length <= 1/.test(header) && /focalRamp\.length > 1 \? identity\.tokens\.accentSoft : undefined/.test(header),
    'collapse pins',
  )
  const critter = readFileSync('src/components/mercury-ui/CritterArt.tsx', 'utf8')
  t.check(
    'the art glow is prop-fed from tokens (glowToward) — CritterArt never derives its own bloom',
    /glowToward\?: string/.test(critter) && !/deriveAccentSoft|resolveMercuryTokens|useMercuryTokens/.test(critter),
    'seam pin',
  )
}

t.section('§5 — the GREETING SHIMMER: settle law, fixed point, bounded damage')
{
  const shim = await import('../../src/utils/cockpit/greetingShimmer.ts')
  const N = 30
  const text = 'M'.repeat(N)
  const plain = cells(rampSegments(text, STOPS))

  // Frame 0 IS the static cell: the ease-in starts at gain 0, whose key
  // parses to a null phase, and a null phase is the byte-exact settled walk.
  t.check("the greeting's first instant renders settled bytes (frame-0 invariant)", shim.shimmerPhaseOf(shim.shimmerPhaseKey(0, N), N) === null, shim.shimmerPhaseKey(0, N))
  t.check(
    'a null shimmer opt is the identity (settled fixed point)',
    JSON.stringify(cells(rampSegments(text, STOPS, { shimmer: null }))) === JSON.stringify(plain),
    'null ≡ plain',
  )

  // THE SETTLE LAW: at (and forever after) the greeting window the phase key
  // is the terminal token — the consumer drops its clock on it.
  t.check('the phase settles at exactly the greeting window', shim.shimmerPhaseKey(shim.SHIMMER_GREETING_MS, N) === shim.SHIMMER_SETTLED, shim.shimmerPhaseKey(shim.SHIMMER_GREETING_MS, N))
  t.check('…and stays settled forever', shim.shimmerPhaseKey(shim.SHIMMER_GREETING_MS + 3_600_000, N) === shim.SHIMMER_SETTLED)
  t.check('…and is still LIVE just inside the ease-out', shim.shimmerPhaseOf(shim.shimmerPhaseKey(shim.SHIMMER_GREETING_MS - shim.SHIMMER_EASE_OUT_MS / 2, N), N) !== null)

  // Mid-greeting: the band changes bytes, but ONLY the band — out-of-band
  // cells byte-equal the settled walk and the damage is bounded by the
  // radius (the handful-of-cells law, never a full-row repaint).
  const key = shim.shimmerPhaseKey(2_000, N)
  const phase = shim.shimmerPhaseOf(key, N)
  t.check('mid-greeting phase is live and quantized', phase !== null && Number.isInteger(phase!.peakCell) && phase!.gainLevel >= 1 && phase!.gainLevel <= shim.SHIMMER_GAIN_LEVELS, key)
  if (phase) {
    const glowed = cells(rampSegments(text, STOPS, { shimmer: phase }))
    let changed = 0
    let outOfBandClean = true
    let onLine = true
    for (let i = 0; i < N; i++) {
      const center = i + 0.5
      const boost = shim.shimmerBoostAt(center, phase)
      if (glowed[i] !== plain[i]) changed++
      if (boost === 0 && glowed[i] !== plain[i]) outOfBandClean = false
      // Every animated cell still samples the family's OWN line: the color
      // is the ramp at the boosted coordinate, never a foreign hue.
      const u = center / N
      const want = rampSampleAt(STOPS, boost > 0 ? u + boost * (1 - u) : u)
      if (glowed[i] !== want) onLine = false
    }
    t.check('the band changes bytes (the greeting is visible)', changed > 0, `${changed} cells`)
    t.check(`per-frame damage ≤ the band (2·radius+1 = ${2 * phase.radiusCells + 1} cells)`, changed <= 2 * phase.radiusCells + 1, `${changed} changed`)
    t.check('out-of-band cells byte-equal the settled walk', outOfBandClean)
    t.check('every animated cell samples the ramp line at the boosted coordinate (no foreign hue)', onLine)
  }

  // Quantization: equal quantized states yield equal keys — equal frames
  // never commit (the BreathingDot lesson, applied to the sweep).
  t.check('nearby times inside one quantum share a key', shim.shimmerPhaseKey(1_000, N) === shim.shimmerPhaseKey(1_003, N), shim.shimmerPhaseKey(1_000, N))

  // The radius law: bounded 3..8 for every plausible span.
  t.check('band radius clamps 3..8 across spans', shim.shimmerRadius(7) === 3 && shim.shimmerRadius(53) === 8 && shim.shimmerRadius(27) >= 3 && shim.shimmerRadius(27) <= 8)

  // The lattice law: the greeting samples on the FOCAL lane of the nested
  // clock family (80 ⊂ 160 ⊂ 320 — prove-motion-hierarchy owns the family).
  t.check('SHIMMER_TICK_MS is the 80ms focal lane', shim.SHIMMER_TICK_MS === 80)

  // The single-stop collapse: reduced-colour families have no gradient to
  // sweep — a shimmer opt on a flat ramp is inert by construction.
  const flatGlow = rampSegments(text, ['#dd4444'], { shimmer: { peakCell: 5, gainLevel: 5, radiusCells: 8 } })
  t.check('single-stop families stay flat under a shimmer phase', flatGlow.length === 1 && flatGlow[0]!.color === '#dd4444', 'flat collapse')
}

t.finish('prove-focal-ramp')
