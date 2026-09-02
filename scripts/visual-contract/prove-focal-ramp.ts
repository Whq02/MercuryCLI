#!/usr/bin/env bun

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
const oracleAscii = (text: string, stops: string[]): string[] =>
  [...text].map((_, x) => oracle(stops, (x + 0.5) / text.length))
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
const CONTINUITY_GATE: Record<number, number> = { 7: 21, 42: 4, 53: 4 }
const OLD_BUCKET_STEP = 64
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

  const combining = 'e\u0301\u0301'
  const comb = rampSegments(combining, STOPS)
  t.check(
    'combining marks never split from their base (one cluster, one segment)',
    comb.length === 1 && joined(comb) === combining,
    JSON.stringify(comb),
  )

  const vs16 = '\u2620\uFE0F'
  const v = rampSegments(vs16, STOPS)
  t.check(
    'a VS16 sequence stays one cluster (never split)',
    v.length === 1 && joined(v) === vs16,
    JSON.stringify(v),
  )

  const wide = '\u30C6\u30B9\u30C8'
  t.check(
    'the substrate agrees the corpus glyphs are 2-cell',
    displayWidth('\u30C6') === 2 && displayWidth('\u6F22') === 2,
    `u30C6=${displayWidth('\u30C6')} u6F22=${displayWidth('\u6F22')}`,
  )
  const w = rampSegments(wide, STOPS)
  t.check(
    'three wide clusters sample at TRUE cell centers (mid = exact stop hit)',
    w.length === 3 &&
      joined(w) === wide &&
      w[0]?.color === oracle(STOPS, 1 / 6) &&
      w[1]?.color === STOPS[1] &&
      w[2]?.color === oracle(STOPS, 5 / 6),
    JSON.stringify(w),
  )

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
  const CASED = ['#DD4444', '#E58484', '#EDE8DD']
  const lead = rampSegments('\u0301M', CASED)
  t.check(
    'u=0 returns stops[0] verbatim (case preserved — endpoint exactness)',
    lead[0]?.color === CASED[0],
    JSON.stringify(lead),
  )

  const merc = rampSegments('MERC', STOPS)
  t.check(
    'quarter-point samples are exact piecewise lerps (oracle equality)',
    JSON.stringify(cells(merc)) === JSON.stringify(oracleAscii('MERC', STOPS)),
    cells(merc).join(','),
  )

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

  for (const W of [7, 42, 53]) {
    const step = maxStep(oldBucketCells(W, darkRamp))
    t.check(
      `old bucket law at W=${W} VIOLATES the gate (measures the recorded ${OLD_BUCKET_STEP})`,
      step === OLD_BUCKET_STEP && step > (CONTINUITY_GATE[W] ?? 0),
      `step=${step}`,
    )
  }

  const probe = ['#000000', '#404040', '#808080']
  const before = JSON.stringify(rampSegments('MMMM', probe))
  probe[1] = '#ff0000'
  const after = JSON.stringify(rampSegments('MMMM', probe))
  t.check('stops parse once per ramp (in-place mutation is invisible)', before === after, after)
  const fresh = JSON.stringify(rampSegments('MMMM', ['#000000', '#404040', '#808080']))
  t.check('equal-content stops give byte-identical segments', fresh === before, fresh)

  const namey = rampSegments('MMMM', ['salmon', '#ff0000'])
  t.check(
    'unparseable ramps sample nearest-stop verbatim (never an invented hue)',
    cells(namey).every(c => c === 'salmon' || c === '#ff0000') &&
      cells(namey)[0] === 'salmon' &&
      cells(namey)[3] === '#ff0000',
    JSON.stringify(namey),
  )

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

  const lockup = readFileSync('src/components/mercury-ui/components.tsx', 'utf8')
  t.check(
    'the ProductLockup title ramps ONLY where the family hosts the ramp (single-stop keeps the flat Wordmark + muted view)',
    /ramp\.length > 1 \?/.test(lockup),
    'gate pin',
  )
  const header = readFileSync('src/components/concourse/ConcourseHeader.tsx', 'utf8')
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

  t.check("the greeting's first instant renders settled bytes (frame-0 invariant)", shim.shimmerPhaseOf(shim.shimmerPhaseKey(0, N), N) === null, shim.shimmerPhaseKey(0, N))
  t.check(
    'a null shimmer opt is the identity (settled fixed point)',
    JSON.stringify(cells(rampSegments(text, STOPS, { shimmer: null }))) === JSON.stringify(plain),
    'null ≡ plain',
  )

  t.check('the phase settles at exactly the greeting window', shim.shimmerPhaseKey(shim.SHIMMER_GREETING_MS, N) === shim.SHIMMER_SETTLED, shim.shimmerPhaseKey(shim.SHIMMER_GREETING_MS, N))
  t.check('…and stays settled forever', shim.shimmerPhaseKey(shim.SHIMMER_GREETING_MS + 3_600_000, N) === shim.SHIMMER_SETTLED)
  t.check('…and is still LIVE just inside the ease-out', shim.shimmerPhaseOf(shim.shimmerPhaseKey(shim.SHIMMER_GREETING_MS - shim.SHIMMER_EASE_OUT_MS / 2, N), N) !== null)

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
      const u = center / N
      const want = rampSampleAt(STOPS, boost > 0 ? u + boost * (1 - u) : u)
      if (glowed[i] !== want) onLine = false
    }
    t.check('the band changes bytes (the greeting is visible)', changed > 0, `${changed} cells`)
    t.check(`per-frame damage ≤ the band (2·radius+1 = ${2 * phase.radiusCells + 1} cells)`, changed <= 2 * phase.radiusCells + 1, `${changed} changed`)
    t.check('out-of-band cells byte-equal the settled walk', outOfBandClean)
    t.check('every animated cell samples the ramp line at the boosted coordinate (no foreign hue)', onLine)
  }

  t.check('nearby times inside one quantum share a key', shim.shimmerPhaseKey(1_000, N) === shim.shimmerPhaseKey(1_003, N), shim.shimmerPhaseKey(1_000, N))

  t.check('band radius clamps 3..8 across spans', shim.shimmerRadius(7) === 3 && shim.shimmerRadius(53) === 8 && shim.shimmerRadius(27) >= 3 && shim.shimmerRadius(27) <= 8)

  t.check('SHIMMER_TICK_MS is the 80ms focal lane', shim.SHIMMER_TICK_MS === 80)

  const flatGlow = rampSegments(text, ['#dd4444'], { shimmer: { peakCell: 5, gainLevel: 5, radiusCells: 8 } })
  t.check('single-stop families stay flat under a shimmer phase', flatGlow.length === 1 && flatGlow[0]!.color === '#dd4444', 'flat collapse')
}

t.finish('prove-focal-ramp')
