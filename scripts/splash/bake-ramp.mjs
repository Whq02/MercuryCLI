#!/usr/bin/env bun
// ============================================================================
//  scripts/splash/bake-ramp.mjs — bake the FOCAL-RAMP LAW + the colour-
//  capability truth table into the enter-screen splash.
//
//  The splash is a standalone child process with no src imports, so the ramp
//  it walks mirrors the canonical owners BY BAKE (the MENU/CRITTER_HUES
//  idiom), never by hand-comment:
//    · RAMP             ← deriveFocalRamp(TERRA, BELLY, IVORY)
//                         (src/utils/mercuryTokens.ts) as RGB triples;
//    · RAMP_FIXTURE     ← rampSampleAt (src/components/mercury-ui/focalRamp.ts)
//                         at the word's ENDPOINT coordinate u = x/(W-1), W=53,
//                         plus the R2 depth law mix(CLAW, face, 0.5) — the
//                         proof anchors for prove-ramp-parity.ts AND
//                         prove-splash.py's rendered-word legs. The endpoint
//                         coordinate (vs rampSegments' center-cell) is the
//                         ruled R2 choice: the word is fixed-width authored
//                         art whose left edge byte-anchors the authored
//                         MIDRED ≡ mixc(DEEPRED, RED, 0.5);
//    · CAPABILITY_TRUTH ← shouldHonorNoColor (src/ink/colorize.ts) + the
//                         MERCURY_TRUECOLOR registry row
//                         (src/substrate/flagRegistry.ts).
//
//    bun run scripts/splash/bake-ramp.mjs           # rewrite the block
//    bun run scripts/splash/bake-ramp.mjs --check   # drift gate (run-all.sh)
//
//  --check exits 1 when the baked block differs from its owners — the
//  regen-wrapper pattern, so a canonical change can never silently trail the
//  deployed splash.
// ============================================================================
import { readFileSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const SPLASH = join(here, '..', '..', 'assets', 'splash', 'splash-core.mjs')
const START = '// MERCURY-RAMP-LAW-START'
const END = '// MERCURY-RAMP-LAW-END'
const FAM_START = '// MERCURY-ACCENT-FAMILIES-START'
const FAM_END = '// MERCURY-ACCENT-FAMILIES-END'

const { TERRA, BELLY, IVORY, CLAW } = await import('../../src/components/mercuryPalette.ts')
const { deriveAccentSoft, deriveFocalRamp } = await import('../../src/utils/mercuryTokens.ts')
const { rampSampleAt } = await import('../../src/components/mercury-ui/focalRamp.ts')
const { shouldHonorNoColor } = await import('../../src/ink/colorize.ts')
const { getFlagSpec } = await import('../../src/substrate/flagRegistry.ts')
const critterData = await import('../../src/utils/cockpit/critterData.ts')

const rgb = hex => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16))
const mixc = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * t))

// ── RAMP: the canonical stops as RGB triples ────────────────────────────────
const stops = deriveFocalRamp(TERRA, BELLY, IVORY)
if (stops.length !== 3) throw new Error(`deriveFocalRamp returned ${stops.length} stops — the bake expects the 3-stop dark family`)
const RAMP = stops.map(rgb)

// ── RAMP_FIXTURE: word-coordinate anchors face+deep, W=53 ───────────────────
const W = 53
const XS = [0, 7, 15, 22, 26, 30, 37, 45, 52]
const CLAW_RGB = rgb(CLAW)
const FIXTURE = XS.map(x => {
  const face = rgb(rampSampleAt(stops, x / (W - 1)))
  const deep = mixc(CLAW_RGB, face, 0.5)
  return [x, ...face, ...deep]
})
// The R2 anchor the whole law hangs on: the left edge's deep ink IS the
// authored MIDRED. A bake that cannot reproduce it must refuse to write.
const edge = FIXTURE[0]
if (!(edge[4] === 172 && edge[5] === 59 && edge[6] === 59)) {
  throw new Error(`R2 anchor broken: deep(0) = ${edge.slice(4)} — expected the authored MIDRED [172,59,59]`)
}

// ── CAPABILITY_TRUTH: the one colour law, from the canonical owners ─────────
const tcRow = getFlagSpec('MERCURY_TRUECOLOR')
if (!tcRow) throw new Error('MERCURY_TRUECOLOR is not a registered flag — the truth table has no canonical anchor')
const CASES = [
  { NO_COLOR: null, FORCE_COLOR: null, MERCURY_TRUECOLOR: null, TERM: 'xterm-256color' },
  { NO_COLOR: '1', FORCE_COLOR: null, MERCURY_TRUECOLOR: null, TERM: 'xterm-256color' },
  { NO_COLOR: '1', FORCE_COLOR: '1', MERCURY_TRUECOLOR: null, TERM: 'xterm-256color' },
  { NO_COLOR: '', FORCE_COLOR: null, MERCURY_TRUECOLOR: null, TERM: 'xterm-256color' },
  { NO_COLOR: '1', FORCE_COLOR: '', MERCURY_TRUECOLOR: null, TERM: 'xterm-256color' },
  { NO_COLOR: null, FORCE_COLOR: null, MERCURY_TRUECOLOR: '0', TERM: 'xterm-256color' },
  { NO_COLOR: null, FORCE_COLOR: null, MERCURY_TRUECOLOR: null, TERM: 'dumb' },
  { NO_COLOR: null, FORCE_COLOR: null, MERCURY_TRUECOLOR: null, TERM: 'linux' },
  { NO_COLOR: '1', FORCE_COLOR: null, MERCURY_TRUECOLOR: '0', TERM: 'xterm-256color' },
]
const modeOf = c => {
  const env = {}
  if (c.NO_COLOR !== null) env.NO_COLOR = c.NO_COLOR
  if (c.FORCE_COLOR !== null) env.FORCE_COLOR = c.FORCE_COLOR
  if (shouldHonorNoColor(env)) return 'plain'
  if (/^(dumb|linux)$/.test(c.TERM)) return '256'
  if (c.MERCURY_TRUECOLOR === '0') return '256'
  return 'truecolor'
}
const TRUTH = CASES.map(c => [c.NO_COLOR, c.FORCE_COLOR, c.MERCURY_TRUECOLOR, c.TERM, modeOf(c)])

// ── ACCENT_FAMILIES: per-critter accent + ramp + 256 pair ─
// From the canonical owners: critterData hues (crab = TERRA/CLAW), the
// deriveAccentSoft 0.4 bloom (crab keeps the authored BELLY byte-equal —
// the law) and deriveFocalRamp; the 256 fallback pair is the crab's
// AUTHORED 167/95 (.red/.dimred — byte-parity with the pre-GLOW
// splash) and the nearest xterm cube index for every other family.
const hexOf = t => '#' + t.map(v => v.toString(16).padStart(2, '0')).join('')
const cube256 = t => {
  const LV = [0, 95, 135, 175, 215, 255]
  const lvl = v => LV.reduce((best, x, i) => (Math.abs(x - v) < Math.abs(LV[best] - v) ? i : best), 0)
  return 16 + 36 * lvl(t[0]) + 6 * lvl(t[1]) + lvl(t[2])
}
const familyOf = (mainHex, deepHex, authoredSoftHex, t256Pair) => {
  const main = rgb(mainHex)
  const deep = rgb(deepHex)
  const soft = rgb(authoredSoftHex ?? deriveAccentSoft(mainHex, IVORY))
  const ramp = deriveFocalRamp(mainHex, hexOf(soft), IVORY).map(rgb)
  const [t256, t256deep] = t256Pair ?? [cube256(main), cube256(deep)]
  return { main, deep, soft, ramp, t256, t256deep }
}
const FAMILIES = {
  crab: familyOf(TERRA, CLAW, BELLY, [167, 95]),
  octopus: familyOf(critterData.OCTOPUS_HUE, critterData.OCTOPUS_HUE_DEEP),
  jellyfish: familyOf(critterData.JELLYFISH_HUE, critterData.JELLYFISH_HUE_DEEP),
  clam: familyOf(critterData.CLAM_HUE, critterData.CLAM_HUE_DEEP),
}
if (JSON.stringify(FAMILIES.crab.ramp) !== JSON.stringify(RAMP)) {
  throw new Error('crab family ramp diverged from the baked RAMP — one law, one value')
}
const DEFAULT_KEY = critterData.DEFAULT_CRITTER_KEY
if (!Object.hasOwn(FAMILIES, DEFAULT_KEY)) {
  throw new Error(`DEFAULT_CRITTER_KEY ${JSON.stringify(DEFAULT_KEY)} is not a baked family — extend the table`)
}
const famBlock = [
  FAM_START + ' (baked by scripts/splash/bake-ramp.mjs — from',
  '// critterData.ts hues + the deriveAccentSoft/deriveFocalRamp laws; do NOT',
  '// hand-edit — rerun the bake; prove-ramp-parity.ts §7 goes red on drift.)',
  'const ACCENT_FAMILIES = {',
  ...Object.entries(FAMILIES).map(
    ([k, f]) =>
      `  ${k}: { main: ${JSON.stringify(f.main)}, deep: ${JSON.stringify(f.deep)}, soft: ${JSON.stringify(f.soft)}, ramp: ${JSON.stringify(f.ramp)}, t256: ${f.t256}, t256deep: ${f.t256deep} },`,
  ),
  '}',
  `const DEFAULT_CRITTER = ${JSON.stringify(DEFAULT_KEY)}`,
  FAM_END,
].join('\n')

// ── the block ───────────────────────────────────────────────────────────────
const block = [
  START + ' (baked by scripts/splash/bake-ramp.mjs — RAMP from',
  '// deriveFocalRamp(TERRA, BELLY, IVORY) · RAMP_FIXTURE from focalRamp.ts',
  "// rampSampleAt at the word's endpoint coordinate u=x/(W-1), W=53, deep =",
  '// mixc(CLAW, face, 0.5) (the R2 law; [0] byte-equals the authored MIDRED) ·',
  '// CAPABILITY_TRUTH from colorize.ts shouldHonorNoColor + the',
  '// MERCURY_TRUECOLOR registry row. Do NOT hand-edit — rerun the bake;',
  '// scripts/splash/prove-ramp-parity.ts + bake-ramp --check go red on drift.)',
  `const RAMP = ${JSON.stringify(RAMP)}`,
  `const RAMP_FIXTURE = ${JSON.stringify(FIXTURE)} // [x, faceRGB..., deepRGB...]`,
  `const CAPABILITY_TRUTH = ${JSON.stringify(TRUTH)} // [NO_COLOR, FORCE_COLOR, MERCURY_TRUECOLOR, TERM, mode]`,
  END,
].join('\n')

const src = readFileSync(SPLASH, 'utf8')
const re = new RegExp(`${START}[\\s\\S]*?${END}`)
const famRe = new RegExp(`${FAM_START}[\\s\\S]*?${FAM_END}`)
if (!re.test(src)) {
  console.error(`bake-ramp: no ${START}..${END} block in the splash — add the markers first`)
  process.exit(1)
}
if (!famRe.test(src)) {
  console.error(`bake-ramp: no ${FAM_START}..${FAM_END} block in the splash — add the markers first`)
  process.exit(1)
}
const next = src.replace(re, block).replace(famRe, famBlock)
if (process.argv.includes('--check')) {
  if (next === src) {
    console.log('bake-ramp --check: baked blocks match the canonical owners')
    process.exit(0)
  }
  console.error('bake-ramp --check: DRIFT — a baked block (RAMP-LAW or ACCENT-FAMILIES) trails its canonical owners; run `bun run scripts/splash/bake-ramp.mjs`')
  process.exit(1)
}
writeFileSync(SPLASH, next)
console.log(`bake-ramp: wrote RAMP (${RAMP.length} stops) + ${FIXTURE.length} fixture anchors + ${TRUTH.length} truth rows + ${Object.keys(FAMILIES).length} accent families (default ${DEFAULT_KEY})`)
