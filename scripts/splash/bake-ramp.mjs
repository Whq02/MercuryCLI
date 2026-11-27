#!/usr/bin/env bun
import { readFileSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { registerGeneratedAsset, registerOnlyRequested } from '../lib/generated-assets-map.mjs'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const SPLASH = join(here, '..', '..', 'assets', 'splash', 'splash-core.mjs')
const ROW = {
  assets: 'assets/splash/splash-core.mjs',
  generator: 'bun scripts/splash/bake-ramp.mjs',
  check: 'bun scripts/splash/bake-ramp.mjs --check',
  sources: 'src/screen/theme/mercuryTokens.ts src/screen/widgets/focalRamp.ts src/screen/theme/mercuryPalette.ts src/screen/renderer/colorize.ts src/screen/renderer/cell-grid.ts src/platform/environment/envUtils.ts src/screen/cockpit/critterData.ts re:MERCURY_TRUECOLOR',
  build: true,
}
if (registerOnlyRequested(ROW)) process.exit(0)

const { TERRA, BELLY, IVORY, CLAW, FAINT, OASIS_GROUND, TRUE_BLACK_GROUND } = await import('../../src/screen/theme/mercuryPalette.ts')
const { deriveAccentSoft, deriveFocalRamp } = await import('../../src/screen/theme/mercuryTokens.ts')
const { rampSampleAt } = await import('../../src/screen/widgets/focalRamp.ts')
const { shouldHonorNoColor, truecolorFingerprint, TRUECOLOR_QUERY, truecolorEcho } = await import('../../src/screen/renderer/colorize.ts')
const { rgbToXterm256, rgbToAnsi16 } = await import('../../src/screen/renderer/cell-grid.ts')
const { isEnvTruthy } = await import('../../src/platform/environment/envUtils.ts')
const { getFlagSpec } = await import('../../src/platform/substrate/flagRegistry.ts')
const critterData = await import('../../src/screen/cockpit/critterData.ts')
const rgb = hex => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16))
const mixc = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * t))

const stops = deriveFocalRamp(TERRA, BELLY, IVORY)
if (stops.length !== 3) throw new Error(`deriveFocalRamp returned ${stops.length} stops — the bake expects the 3-stop dark family`)
const RAMP = stops.map(rgb)

const W = 53
const XS = [0, 7, 15, 22, 26, 30, 37, 45, 52]
const CLAW_RGB = rgb(CLAW)
const FIXTURE = XS.map(x => {
  const face = rgb(rampSampleAt(stops, x / (W - 1)))
  const deep = mixc(CLAW_RGB, face, 0.5)
  return [x, ...face, ...deep]
})
const edge = FIXTURE[0]
if (!(edge[4] === 172 && edge[5] === 59 && edge[6] === 59)) {
  throw new Error(`R2 anchor broken: deep(0) = ${edge.slice(4)} — expected the authored MIDRED [172,59,59]`)
}

const tcRow = getFlagSpec('MERCURY_TRUECOLOR')
if (!tcRow) throw new Error('MERCURY_TRUECOLOR is not a registered flag — the truth table has no canonical anchor')
const CASES = [
  { NO_COLOR: null, FORCE_COLOR: null, MERCURY_TRUECOLOR: null, TERM: 'xterm-256color', COLORTERM: 'truecolor', TERM_PROGRAM: null },
  { NO_COLOR: '1', FORCE_COLOR: null, MERCURY_TRUECOLOR: null, TERM: 'xterm-256color', COLORTERM: 'truecolor', TERM_PROGRAM: null },
  { NO_COLOR: '1', FORCE_COLOR: '1', MERCURY_TRUECOLOR: null, TERM: 'xterm-256color', COLORTERM: 'truecolor', TERM_PROGRAM: null },
  { NO_COLOR: '', FORCE_COLOR: null, MERCURY_TRUECOLOR: null, TERM: 'xterm-256color', COLORTERM: 'truecolor', TERM_PROGRAM: null },
  { NO_COLOR: '1', FORCE_COLOR: '', MERCURY_TRUECOLOR: null, TERM: 'xterm-256color', COLORTERM: 'truecolor', TERM_PROGRAM: null },
  { NO_COLOR: null, FORCE_COLOR: null, MERCURY_TRUECOLOR: '0', TERM: 'xterm-256color', COLORTERM: 'truecolor', TERM_PROGRAM: null },
  { NO_COLOR: null, FORCE_COLOR: null, MERCURY_TRUECOLOR: null, TERM: 'dumb', COLORTERM: 'truecolor', TERM_PROGRAM: null },
  { NO_COLOR: null, FORCE_COLOR: null, MERCURY_TRUECOLOR: null, TERM: 'linux', COLORTERM: 'truecolor', TERM_PROGRAM: null },
  { NO_COLOR: '1', FORCE_COLOR: null, MERCURY_TRUECOLOR: '0', TERM: 'xterm-256color', COLORTERM: 'truecolor', TERM_PROGRAM: null },
  { NO_COLOR: null, FORCE_COLOR: null, MERCURY_TRUECOLOR: null, TERM: 'xterm-256color', COLORTERM: null, TERM_PROGRAM: null },
  { NO_COLOR: null, FORCE_COLOR: null, MERCURY_TRUECOLOR: null, TERM: 'xterm-256color', COLORTERM: null, TERM_PROGRAM: 'Apple_Terminal' },
  { NO_COLOR: null, FORCE_COLOR: null, MERCURY_TRUECOLOR: null, TERM: 'xterm-256color', COLORTERM: 'truecolor', TERM_PROGRAM: 'Apple_Terminal' },
  { NO_COLOR: null, FORCE_COLOR: null, MERCURY_TRUECOLOR: null, TERM: 'xterm-256color', COLORTERM: '24bit', TERM_PROGRAM: null },
  { NO_COLOR: null, FORCE_COLOR: null, MERCURY_TRUECOLOR: null, TERM: 'xterm-256color', COLORTERM: null, TERM_PROGRAM: 'vscode' },
  { NO_COLOR: null, FORCE_COLOR: null, MERCURY_TRUECOLOR: null, TERM: 'xterm-256color', COLORTERM: null, TERM_PROGRAM: 'iTerm.app' },
  { NO_COLOR: null, FORCE_COLOR: null, MERCURY_TRUECOLOR: null, TERM: 'xterm-kitty', COLORTERM: null, TERM_PROGRAM: null },
  { NO_COLOR: null, FORCE_COLOR: null, MERCURY_TRUECOLOR: '1', TERM: 'xterm-256color', COLORTERM: null, TERM_PROGRAM: null },
  { NO_COLOR: null, FORCE_COLOR: null, MERCURY_TRUECOLOR: '1', TERM: 'xterm-256color', COLORTERM: null, TERM_PROGRAM: 'Apple_Terminal' },
  { NO_COLOR: '1', FORCE_COLOR: '1', MERCURY_TRUECOLOR: null, TERM: 'xterm-256color', COLORTERM: null, TERM_PROGRAM: null },
  { NO_COLOR: null, FORCE_COLOR: null, MERCURY_TRUECOLOR: '1', TERM: 'linux', COLORTERM: null, TERM_PROGRAM: null },
  { NO_COLOR: null, FORCE_COLOR: null, MERCURY_TRUECOLOR: null, TERM: 'xterm', COLORTERM: null, TERM_PROGRAM: null },
  { NO_COLOR: null, FORCE_COLOR: null, MERCURY_TRUECOLOR: null, TERM: 'xterm-color', COLORTERM: null, TERM_PROGRAM: null },
  { NO_COLOR: null, FORCE_COLOR: null, MERCURY_TRUECOLOR: null, TERM: 'screen', COLORTERM: null, TERM_PROGRAM: null },
  { NO_COLOR: null, FORCE_COLOR: null, MERCURY_TRUECOLOR: null, TERM: 'vt100', COLORTERM: null, TERM_PROGRAM: null },
  { NO_COLOR: null, FORCE_COLOR: null, MERCURY_TRUECOLOR: null, TERM: 'rxvt', COLORTERM: null, TERM_PROGRAM: null },
  { NO_COLOR: null, FORCE_COLOR: null, MERCURY_TRUECOLOR: null, TERM: 'alacritty', COLORTERM: null, TERM_PROGRAM: null },
  { NO_COLOR: null, FORCE_COLOR: null, MERCURY_TRUECOLOR: null, TERM: 'foot', COLORTERM: null, TERM_PROGRAM: null },
  { NO_COLOR: null, FORCE_COLOR: null, MERCURY_TRUECOLOR: null, TERM: null, COLORTERM: null, TERM_PROGRAM: null },
  { NO_COLOR: null, FORCE_COLOR: null, MERCURY_TRUECOLOR: null, TERM: 'xterm', COLORTERM: 'truecolor', TERM_PROGRAM: null },
  { NO_COLOR: null, FORCE_COLOR: null, MERCURY_TRUECOLOR: '1', TERM: 'xterm', COLORTERM: null, TERM_PROGRAM: null },
]
const modeOf = c => {
  const env = {}
  for (const key of ['NO_COLOR', 'FORCE_COLOR', 'MERCURY_TRUECOLOR', 'TERM', 'COLORTERM', 'TERM_PROGRAM']) {
    if (c[key] !== null) env[key] = c[key]
  }
  if (shouldHonorNoColor(env)) return 'plain'
  const term = c.TERM ?? ''
  if (!term || term === 'dumb') return 'plain'
  if (term !== 'linux' && c.MERCURY_TRUECOLOR !== '0') {
    if (isEnvTruthy(c.MERCURY_TRUECOLOR ?? undefined) || truecolorFingerprint(env) !== null) return 'truecolor'
  }
  return /-(?:256color|256)$/.test(term) ? '256' : '16'
}
const TRUTH = CASES.map(c => [c.NO_COLOR, c.FORCE_COLOR, c.MERCURY_TRUECOLOR, c.TERM, c.COLORTERM, c.TERM_PROGRAM, modeOf(c)])
const ECHO_SAMPLES = [
  '0;48:2::1:2:3m',
  '0;48:2:1:1:2:3m',
  '48:2:1:2:3m',
  '0;48;2;1;2;3m',
  '0;8;30;48:2::1:2:3m',
  '48;2;0;1;2;3m',
  '0m',
  '0;48:5:16m',
  '0;38:2::1:2:3m',
  '0;48:2::1:2:30m',
  '',
]
const ECHO_TRUTH = ECHO_SAMPLES.map(s => [s, truecolorEcho(s)])
const hexOf = t => '#' + t.map(v => v.toString(16).padStart(2, '0')).join('')
const to256 = ([r, g, b]) => rgbToXterm256(r, g, b)
const to16 = ([r, g, b]) => {
  const n = rgbToAnsi16(r, g, b)
  return n < 8 ? 30 + n : 82 + n
}
const sampleStops = (stopsRgb, u) => {
  const s = Math.min(1, Math.max(0, u)) * (stopsRgb.length - 1)
  const i = Math.min(stopsRgb.length - 2, Math.floor(s))
  return mixc(stopsRgb[i], stopsRgb[i + 1], s - i)
}
const NAMED_RGB = {
  cream: [240, 232, 214],
  ivory: rgb(IVORY),
  red: rgb(TERRA),
  faint: rgb(FAINT),
  dim: [168, 152, 128],
  dimred: CLAW_RGB,
  midred: mixc(CLAW_RGB, rgb(TERRA), 0.5),
  dune: [47, 75, 82],
  teal: [63, 191, 160],
  amber: [219, 161, 61],
  crimson: [232, 85, 106],
  dark: rgb(OASIS_GROUND.NIGHT),
  black: rgb(TRUE_BLACK_GROUND.NIGHT),
}
const T256 = Object.fromEntries(Object.entries(NAMED_RGB).map(([k, v]) => [k, to256(v)]))
const T16 = Object.fromEntries(Object.entries(NAMED_RGB).map(([k, v]) => [k, to16(v)]))
const familyOf = (mainHex, deepHex, authoredSoftHex) => {
  const main = rgb(mainHex)
  const deep = rgb(deepHex)
  const soft = rgb(authoredSoftHex ?? deriveAccentSoft(mainHex, IVORY))
  const ramp = deriveFocalRamp(mainHex, hexOf(soft), IVORY).map(rgb)
  const mid = mixc(deep, main, 0.5)
  const t256 = to256(main)
  const t256deep = to256(deep)
  const t256mid = to256(mid)
  const t16 = to16(main)
  const t16deep = to16(deep)
  const t16mid = to16(mid)
  const wordR256 = Array.from({ length: W }, (_, x) => to256(sampleStops(ramp, x / (W - 1))))
  const wordD256 = Array.from({ length: W }, (_, x) => to256(mixc(deep, sampleStops(ramp, x / (W - 1)), 0.5)))
  return { main, deep, soft, ramp, t256, t256deep, t256mid, t16, t16deep, t16mid, wordR256, wordD256 }
}
const FAMILIES = {
  crab: familyOf(TERRA, CLAW, BELLY),
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
  'const ACCENT_FAMILIES = {',
  ...Object.entries(FAMILIES).map(
    ([k, f]) =>
      `  ${k}: { main: ${JSON.stringify(f.main)}, deep: ${JSON.stringify(f.deep)}, soft: ${JSON.stringify(f.soft)}, ramp: ${JSON.stringify(f.ramp)}, t256: ${f.t256}, t256deep: ${f.t256deep}, t256mid: ${f.t256mid}, t16: ${f.t16}, t16deep: ${f.t16deep}, t16mid: ${f.t16mid}, wordR256: ${JSON.stringify(f.wordR256)}, wordD256: ${JSON.stringify(f.wordD256)} },`,
  ),
  '}',
  `const DEFAULT_CRITTER = ${JSON.stringify(DEFAULT_KEY)}`,
].join('\n')

const block = [
  `const RAMP = ${JSON.stringify(RAMP)}`,
  `const RAMP_FIXTURE = ${JSON.stringify(FIXTURE)}`,
  `const CAPABILITY_TRUTH = ${JSON.stringify(TRUTH)}`,
  `const TRUECOLOR_QUERY = ${JSON.stringify(TRUECOLOR_QUERY)}`,
  `const TRUECOLOR_ECHO_TRUTH = ${JSON.stringify(ECHO_TRUTH)}`,
].join('\n')

const src = readFileSync(SPLASH, 'utf8')
const t256Re = /^const T256 = [^\n]*(?:\nconst T16 = [^\n]*)?$/m
const re = /^const RAMP = [^\n]*\nconst RAMP_FIXTURE = [^\n]*\nconst CAPABILITY_TRUTH = [^\n]*(?:\nconst TRUECOLOR_QUERY = [^\n]*\nconst TRUECOLOR_ECHO_TRUTH = [^\n]*)?$/m
const famRe = /^const ACCENT_FAMILIES = \{\n[\s\S]*?^\}\nconst DEFAULT_CRITTER = [^\n]*$/m
if (!t256Re.test(src)) {
  console.error('bake-ramp: no T256 declaration in the splash — add it first')
  process.exit(1)
}
if (!re.test(src)) {
  console.error('bake-ramp: no RAMP · RAMP_FIXTURE · CAPABILITY_TRUTH declarations in the splash — add them first')
  process.exit(1)
}
if (!famRe.test(src)) {
  console.error('bake-ramp: no ACCENT_FAMILIES … DEFAULT_CRITTER declarations in the splash — add them first')
  process.exit(1)
}
const next = src.replace(t256Re, () => `const T256 = ${JSON.stringify(T256)}\nconst T16 = ${JSON.stringify(T16)}`).replace(re, () => block).replace(famRe, () => famBlock)
if (process.argv.includes('--check')) {
  if (next === src) {
    console.log('bake-ramp --check: baked blocks match the canonical owners')
    process.exit(0)
  }
  console.error('bake-ramp --check: DRIFT — a baked block (RAMP-LAW or ACCENT-FAMILIES) trails its canonical owners; run `bun run scripts/splash/bake-ramp.mjs`')
  process.exit(1)
}
writeFileSync(SPLASH, next)
registerGeneratedAsset(ROW)
console.log(`bake-ramp: wrote RAMP (${RAMP.length} stops) + ${FIXTURE.length} fixture anchors + ${TRUTH.length} truth rows + ${Object.keys(FAMILIES).length} accent families (default ${DEFAULT_KEY})`)
