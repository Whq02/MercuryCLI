#!/usr/bin/env bun
// ============================================================================
//  scripts/splash/prove-ramp-parity.ts — the splash's colour math is PROVEN
//  against the canonical owners (RF-11, closing D7: the ramp and
//  palette constants would otherwise mirror src by COMMENT only).
//
//  Three-way triangulation: the BAKED block (bake-ramp.mjs writes it from
//  rampSampleAt) is compared here against an INDEPENDENT reimplementation of
//  the continuous law over the canonical stops — so the splash runtime, the
//  bake, and the kit sampler must all agree byte-for-byte or this goes red.
//
//    §1 the baked RAMP equals deriveFocalRamp(TERRA, BELLY, IVORY);
//    §2 the baked fixture equals the independent oracle at u=x/(W-1), the
//       R2 depth law holds per anchor, and the left edge IS the authored
//       MIDRED byte-exactly;
//    §3 the baked capability table equals the canonical truth
//       (shouldHonorNoColor + the MERCURY_TRUECOLOR registry row);
//    §4 the splash's hand palette constants equal mercuryPalette (RED=TERRA,
//       DEEPRED=CLAW, IVORY, FAINT) and MIDRED ≡ mixc(DEEPRED,RED,.5);
//    §5 the baked markers + never-hand-edit contract are present, and the
//       runtime samplers consume the baked stops (no second stop table);
//    §7 the baked ACCENT_FAMILIES equal the canonical
//       derivations per critter (crab byte-equal to the pre-GLOW authored
//       values; DEFAULT_CRITTER == critterData's DEFAULT_CRITTER_KEY), and
//       the splash's hand-mirrored greeting-shimmer law equals the kit's
//       canonical schedule (greetingShimmer.ts) value-for-value.
// ============================================================================

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { BELLY, CLAW, FAINT, IVORY, TERRA } from '../../src/components/mercuryPalette.ts'
import { deriveFocalRamp } from '../../src/utils/mercuryTokens.ts'
import { shouldHonorNoColor } from '../../src/ink/colorize.ts'
import { getFlagSpec } from '../../src/substrate/flagRegistry.ts'
import { GROUND, GROUND_FAMILIES, adoptGroundFamily } from '../../assets/splash/splash-core.mjs'
import { NIGHT, OASIS_GROUND, TRUE_BLACK_GROUND } from '../../src/components/mercuryPalette.ts'
import { checker } from '../engine-durability/harness.ts'

const t = checker()
// the ramp law, palette and rasterHard live
// in the shared compose CORE. (GLOW: the driver's ripple-side
// BELLY constant retired onto the baked family SOFT — §7a pins crab.soft ==
// the canonical BELLY, so the authored bloom stays anchored.)
// The proof greps the pair with the core FIRST so every `const NAME =` grab
// resolves at the one compose owner.
const CORE_PATH = join(import.meta.dir, '..', '..', 'assets', 'splash', 'splash-core.mjs')
const DRIVER_PATH = join(import.meta.dir, '..', '..', 'assets', 'splash', 'mercury-splash.mjs')
const src = readFileSync(CORE_PATH, 'utf8') + '\n' + readFileSync(DRIVER_PATH, 'utf8')

const rgb = (hex: string): number[] => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16))
const mixc = (a: number[], b: number[], f: number): number[] =>
  a.map((v, i) => Math.round(v + ((b[i] ?? 0) - v) * f))

const grab = (name: string): unknown => {
  const m = src.match(new RegExp(`const ${name} = (\\[[^\\n]*\\])`))
  if (!m) throw new Error(`const ${name} not found in the splash`)
  return JSON.parse((m[1] ?? '').replace(/ \/\/.*$/, ''))
}

const RAMP = grab('RAMP') as number[][]
const FIXTURE = grab('RAMP_FIXTURE') as number[][]
const TRUTH = grab('CAPABILITY_TRUTH') as Array<Array<string | null>>

t.section('§1 — baked RAMP equals the canonical derivation')
{
  const stops = deriveFocalRamp(TERRA, BELLY, IVORY)
  t.check('the dark family derives 3 stops', stops.length === 3, stops.join(' '))
  t.check(
    'baked RAMP == deriveFocalRamp(TERRA, BELLY, IVORY) as RGB triples',
    JSON.stringify(RAMP) === JSON.stringify(stops.map(rgb)),
    JSON.stringify(RAMP),
  )
}

t.section('§2 — baked fixture equals the independent oracle (R2 law)')
{
  const stops = deriveFocalRamp(TERRA, BELLY, IVORY).map(rgb)
  const oracle = (u: number): number[] => {
    const s = Math.min(1, Math.max(0, u)) * (stops.length - 1)
    const i = Math.min(stops.length - 2, Math.floor(s))
    return mixc(stops[i] ?? [], stops[i + 1] ?? [], s - i)
  }
  const W = 53
  const clawRgb = rgb(CLAW)
  let allOk = FIXTURE.length > 0
  for (const row of FIXTURE) {
    const [x, ...rest] = row
    const face = rest.slice(0, 3)
    const deep = rest.slice(3)
    const wantFace = oracle((x ?? 0) / (W - 1))
    const wantDeep = mixc(clawRgb, wantFace, 0.5)
    if (JSON.stringify(face) !== JSON.stringify(wantFace)) allOk = false
    if (JSON.stringify(deep) !== JSON.stringify(wantDeep)) allOk = false
  }
  t.check(`all ${FIXTURE.length} fixture anchors equal the oracle (face + deep)`, allOk, JSON.stringify(FIXTURE[0]))
  const edge = FIXTURE[0] ?? []
  t.check(
    'the left edge deep ink IS the authored MIDRED [172,59,59] byte-exactly',
    edge[0] === 0 && edge[4] === 172 && edge[5] === 59 && edge[6] === 59,
    JSON.stringify(edge),
  )
  const mid = FIXTURE.find(r => r[0] === 26) ?? []
  t.check(
    'the exact mid column (x=26, u=0.5) hits BELLY exactly (stop-hit law)',
    JSON.stringify(mid.slice(1, 4)) === JSON.stringify(rgb(BELLY)),
    JSON.stringify(mid),
  )
}

t.section('§3 — baked capability truth equals the canonical law')
{
  const spec = getFlagSpec('MERCURY_TRUECOLOR')
  t.check('MERCURY_TRUECOLOR is a registered flag', !!spec, JSON.stringify(spec?.env))
  let allOk = TRUTH.length > 0
  for (const row of TRUTH) {
    const [nc, fc, mt, term, mode] = row
    const env: { NO_COLOR?: string; FORCE_COLOR?: string } = {}
    if (nc !== null) env.NO_COLOR = nc ?? undefined
    if (fc !== null) env.FORCE_COLOR = fc ?? undefined
    const want = shouldHonorNoColor(env)
      ? 'plain'
      : /^(dumb|linux)$/.test(term ?? '')
        ? '256'
        : mt === '0'
          ? '256'
          : 'truecolor'
    if (mode !== want) allOk = false
  }
  t.check(`all ${TRUTH.length} truth rows match shouldHonorNoColor + the fallback law`, allOk, JSON.stringify(TRUTH))
  const modes = new Set(TRUTH.map(r => r[4]))
  t.check(
    'the table exercises all three modes (plain, 256, truecolor)',
    modes.has('plain') && modes.has('256') && modes.has('truecolor'),
    [...modes].join(','),
  )
}

t.section('§4 — the splash hand palette equals mercuryPalette')
{
  // (BELLY left this table with the driver's ripple constant — GLOW: the
  //  crab family's baked `soft` carries the authored bloom now, pinned §7a.)
  const pairs: Array<[string, number[]]> = [
    ['RED', rgb(TERRA)],
    ['DEEPRED', rgb(CLAW)],
  ]
  for (const [name, want] of pairs) {
    const got = grab(name) as number[]
    t.check(`splash ${name} == canonical ${JSON.stringify(want)}`, JSON.stringify(got) === JSON.stringify(want), JSON.stringify(got))
  }
  const ivoryM = src.match(/const IVORY = '(#[0-9A-Fa-f]{6})'/)
  t.check('splash IVORY == canonical IVORY', ivoryM?.[1] === IVORY, String(ivoryM?.[1]))
  const faintM = src.match(/const FAINT = '(#[0-9A-Fa-f]{6})'/)
  t.check('splash FAINT == canonical FAINT', faintM?.[1] === FAINT, String(faintM?.[1]))
  const midred = grab('MIDRED') as number[]
  t.check(
    'MIDRED ≡ mixc(DEEPRED, RED, 0.5) (the authored depth anchor)',
    JSON.stringify(midred) === JSON.stringify(mixc(rgb(CLAW), rgb(TERRA), 0.5)),
    JSON.stringify(midred),
  )
}

t.section('§5 — bake contract integrity')
{
  t.check(
    'the RAMP-LAW markers are present with the never-hand-edit contract',
    src.includes('MERCURY-RAMP-LAW-START') && src.includes('MERCURY-RAMP-LAW-END') && /RAMP-LAW-START[\s\S]{0,400}Do NOT hand-edit/.test(src),
    'markers',
  )
  t.check(
    'the runtime samplers consume the baked stops (rampSample walks RAMP; the live sampleFace walks ACC.ramp, whose every family row is baked; no second stop table)',
    /const rampSample = u =>[\s\S]{0,200}RAMP\[i\]/.test(src) &&
      /const sampleFace = u =>[\s\S]{0,220}ACC\.ramp\[i\]/.test(src) &&
      !src.includes('rampStopAt'),
    'rampSample + sampleFace',
  )
  t.check(
    'the mixed-cell arm routes BOTH channels through the tone mapper (RF-08)',
    /paint\(px\(t, x\)\) \+ paintBg\(px\(b, x\)\)/.test(src),
    'rasterHard t!==b arm',
  )
}

t.section('§6 — the flat-ground pair-law (round 7: the vignette sampler is retired)')
{
  // Round 7 retired the vignette wash and its
  // sampler (vignetteToneAt/vignetteCellTone, GRAD_BAND/GRAD_EDGE): no host
  // paints a field background — composed glyphs ride the ONE shared ground.
  // The §6 sampler oracle retired WITH its subject; what remains provable is
  // the pair-law and the absence of any second sampler.
  // §6a — the shared GROUND is mercuryPalette NIGHT byte-exactly (the
  // launcher's OSC-11 value and the runtime's oasis ground are ONE pair).
  {
    const rgbN = rgb(NIGHT)
    t.check(
      'core GROUND == mercuryPalette NIGHT (#0D181B) byte-exactly',
      JSON.stringify(GROUND) === JSON.stringify(rgbN),
      `${JSON.stringify(GROUND)} vs ${JSON.stringify(rgbN)}`,
    )
    // §6a′ — the two appearances' grounds: the splash family table equals
    // mercuryPalette's ground owners byte-exactly, and adoptGroundFamily
    // re-anchors the ONE shared reference in place (GROUND keeps its
    // identity — every plate/park/mix consumer reads the new family live).
    t.check(
      'GROUND_FAMILIES.dark == mercuryPalette OASIS_GROUND.NIGHT byte-exactly',
      JSON.stringify(GROUND_FAMILIES.dark) === JSON.stringify(rgb(OASIS_GROUND.NIGHT)),
    )
    t.check(
      "GROUND_FAMILIES['true-black'] == mercuryPalette TRUE_BLACK_GROUND.NIGHT (#000000)",
      JSON.stringify(GROUND_FAMILIES['true-black']) === JSON.stringify(rgb(TRUE_BLACK_GROUND.NIGHT)),
    )
    const ref = GROUND
    adoptGroundFamily('true-black')
    t.check(
      'adoptGroundFamily(true-black) re-anchors GROUND in place to #000000',
      ref === GROUND && JSON.stringify(GROUND) === JSON.stringify([0, 0, 0]),
      JSON.stringify(GROUND),
    )
    adoptGroundFamily('no-such-family')
    t.check('an unknown family name keeps the dark identity', JSON.stringify(GROUND) === JSON.stringify(rgbN))
    adoptGroundFamily('dark')
    t.check('adoptGroundFamily(dark) restores NIGHT exactly', JSON.stringify(GROUND) === JSON.stringify(rgbN))
  }
  // §6b — the retirement is COMPLETE: neither the core nor the driver
  // carries a vignette sampler, a canvas emitter, or the retired GRAD pair;
  // the driver derives its OSC-11 write from the exported GROUND.
  {
    const driver = readFileSync(DRIVER_PATH, 'utf8')
    t.check(
      'no vignette machinery survives in the pair (declaration census — prose mentions of the retirement are fine)',
      !src.includes('function vignetteToneAt') &&
        !src.includes('function vignetteCellTone') &&
        !src.includes('const GRAD_BAND =') &&
        !src.includes('const GRAD_EDGE =') &&
        !driver.includes('function canvasRowSGRRuns') &&
        !driver.includes('function bodyOnCanvas') &&
        !driver.includes('GRADIENT_ON'),
      'retired clean',
    )
    t.check(
      "the driver's OSC-11 write derives from the exported GROUND (the pair can never drift)",
      driver.includes("out.write('\\x1b]11;#' + GROUND.map(") && driver.includes('GROUND, assembleCardRows'),
      'OSC-11 rides GROUND',
    )
  }
  // §6c — ROUND 8: the plate tone IS the ground —
  // panels are borders on the one flat NIGHT surface (the REPL model); a
  // lifted plate was the last non-NIGHT surface and read as a mismatch.
  {
    t.check('PLATE_TONE IS the ground alias (const PLATE_TONE = VOID)', src.includes('const PLATE_TONE = VOID'), 'alias present')
    const voidTone = grab('VOID') as number[]
    t.check('VOID (== GROUND == the plate) is NIGHT #0D181B byte-exactly', JSON.stringify(voidTone) === JSON.stringify([13, 24, 27]), JSON.stringify(voidTone))
  }
}

t.section('§7 — GLOW: accent families + the mirrored greeting law')
{
  // §7a — every baked family equals the canonical derivation: main/deep from
  // critterData (crab = TERRA/CLAW), soft = BELLY for crab
  // else deriveAccentSoft(main, IVORY), ramp = deriveFocalRamp at those
  // stops; crab's 256 pair stays the authored.red/.dimred.
  const cd = await import('../../src/utils/cockpit/critterData.ts')
  const { deriveAccentSoft } = await import('../../src/utils/mercuryTokens.ts')
  const core = await import('../../assets/splash/splash-core.mjs')
  const fams = core.ACCENT_FAMILIES as Record<
    string,
    { main: number[]; deep: number[]; soft: number[]; ramp: number[][]; t256: number; t256deep: number }
  >
  const hexOf = (t2: number[]): string => '#' + t2.map(v => v.toString(16).padStart(2, '0')).join('')
  const want: Record<string, { main: string; deep: string; soft?: string }> = {
    crab: { main: TERRA, deep: CLAW, soft: BELLY },
    octopus: { main: cd.OCTOPUS_HUE, deep: cd.OCTOPUS_HUE_DEEP },
    jellyfish: { main: cd.JELLYFISH_HUE, deep: cd.JELLYFISH_HUE_DEEP },
    clam: { main: cd.CLAM_HUE, deep: cd.CLAM_HUE_DEEP },
  }
  t.check('exactly the four pool families are baked', JSON.stringify(Object.keys(fams).sort()) === JSON.stringify(['clam', 'crab', 'jellyfish', 'octopus']), Object.keys(fams).join(','))
  for (const [key, w] of Object.entries(want)) {
    const f = fams[key]!
    const softHex = w.soft ?? deriveAccentSoft(w.main, IVORY)
    const wantRamp = deriveFocalRamp(w.main, softHex, IVORY).map(rgb)
    t.check(
      `${key}: main/deep/soft/ramp equal the canonical derivation`,
      JSON.stringify(f.main) === JSON.stringify(rgb(w.main)) &&
        JSON.stringify(f.deep) === JSON.stringify(rgb(w.deep)) &&
        JSON.stringify(f.soft) === JSON.stringify(rgb(softHex)) &&
        JSON.stringify(f.ramp) === JSON.stringify(wantRamp),
      `${hexOf(f.main)} ${hexOf(f.deep)} ${hexOf(f.soft)}`,
    )
  }
  t.check('crab keeps the authored 256 pair (T256.red 167 / T256.dimred 95)', fams.crab!.t256 === 167 && fams.crab!.t256deep === 95, `${fams.crab!.t256}/${fams.crab!.t256deep}`)
  t.check(
    'DEFAULT_CRITTER == critterData.DEFAULT_CRITTER_KEY (a fresh splash and its booted session wear the same creature)',
    core.DEFAULT_CRITTER === cd.DEFAULT_CRITTER_KEY,
    `${core.DEFAULT_CRITTER} vs ${cd.DEFAULT_CRITTER_KEY}`,
  )
  t.check(
    "accentFamilyKeyOf normalises like sessionAccent's poolKeyOr (retired spellings → the successor; keys with none → the default)",
    core.accentFamilyKeyOf('mantis') === 'clam' &&
      core.accentFamilyKeyOf('mantis shrimp') === 'clam' &&
      core.accentFamilyKeyOf('dragon') === cd.DEFAULT_CRITTER_KEY &&
      core.accentFamilyKeyOf('CRAB') === 'crab' &&
      core.accentFamilyKeyOf('') === cd.DEFAULT_CRITTER_KEY,
    'poolKey law',
  )

  // §7b — the factory's crab default is BYTE-parity: an accent-less core and
  // an explicit-crab core emit identical bytes for the ramped surfaces.
  const bare = core.createSplashCore({ nocolor: false, truecolor: true })
  const crab = core.createSplashCore({ nocolor: false, truecolor: true, accent: 'crab' })
  const sameLabel = bare.rampLabel('New Session in mercury') === crab.rampLabel('New Session in mercury')
  const sameDiv = bare.dividerLine(53) === crab.dividerLine(53)
  const sameWord =
    JSON.stringify(bare.rasterHard(core.WORD, bare.wordTone).lines) ===
    JSON.stringify(crab.rasterHard(core.WORD, crab.wordTone).lines)
  t.check('accent-less core ≡ explicit crab (label + divider + word bytes)', sameLabel && sameDiv && sameWord, 'crab default parity')

  // §7c — the hand-mirrored greeting law equals the kit's canonical schedule
  // value-for-value across a dense (elapsed × span) grid, and the per-cell
  // boost law agrees at every cell — the mirror can never drift silently.
  const kit = await import('../../src/utils/cockpit/greetingShimmer.ts')
  t.check('tick cadence mirrors (GLOW_TICK_MS == SHIMMER_TICK_MS)', core.GLOW_TICK_MS === kit.SHIMMER_TICK_MS, `${core.GLOW_TICK_MS}`)
  let phaseOk = true
  let boostOk = true
  for (const span of [7, 15, 23, 27, 42, 53]) {
    for (let t2 = 0; t2 <= 11_000; t2 += 40) {
      const mirrored = core.glowPhaseAt(t2, span) as { peakCell: number; gainLevel: number; radiusCells: number } | null
      const canonical = kit.shimmerPhaseOf(kit.shimmerPhaseKey(t2, span), span)
      if (JSON.stringify(mirrored) !== JSON.stringify(canonical)) phaseOk = false
      if (mirrored && canonical) {
        for (let c = 0; c <= span; c += 1) {
          if (Math.abs(core.glowBoostAt(c, mirrored) - kit.shimmerBoostAt(c, canonical)) > 1e-12) boostOk = false
        }
      }
    }
  }
  t.check('glowPhaseAt ≡ the kit phase law over the (elapsed × span) grid', phaseOk, 'phase mirror')
  t.check('glowBoostAt ≡ the kit boost law at every cell', boostOk, 'boost mirror')
  t.check('the settle law mirrors (settled at exactly the greeting window)', core.glowSettled(kit.SHIMMER_GREETING_MS) === true && core.glowSettled(kit.SHIMMER_GREETING_MS - 1) === false, 'settle edge')

  // §7d — the settled composition is the greeting's fixed point: a null
  // phase (and any out-of-band cell) emits the settled bytes verbatim.
  const jelly = core.createSplashCore({ nocolor: false, truecolor: true, accent: 'jellyfish' })
  const settled = jelly.rampLabel('New Session in mercury')
  t.check('rampLabel(text, null) ≡ rampLabel(text) (null phase is the settled frame)', jelly.rampLabel('New Session in mercury', null) === settled, 'null-phase fixed point')
  const farPhase = { peakCell: -1000, gainLevel: 5, radiusCells: 8 }
  t.check('an out-of-band phase emits the settled bytes (boost 0 everywhere)', jelly.rampLabel('New Session in mercury', farPhase) === settled, 'out-of-band fixed point')
  const midPhase = core.glowPhaseAt(2_000, 22)
  t.check('an in-band phase CHANGES bytes (the greeting is visible)', midPhase !== null && jelly.rampLabel('New Session in mercury', midPhase) !== settled, 'in-band delta')
  const wordSettled = JSON.stringify(jelly.rasterHard(core.WORD, jelly.wordToneGlow(null)).lines)
  t.check('wordToneGlow(null) ≡ the settled word', wordSettled === JSON.stringify(jelly.rasterHard(core.WORD, jelly.wordTone).lines), 'word fixed point')
}

t.finish('prove-ramp-parity')
