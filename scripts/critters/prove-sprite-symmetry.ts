#!/usr/bin/env bun
// ============================================================================
//  prove-sprite-symmetry — the MIRROR law over every critter's REST POSE in
//  EVERY form (the operator's bar: the large sprites' quality applies at
//  every size; operator ruling on the clam hero: "make it
//  symmetrical" — every form mirror-symmetric on its vertical axis, and the
//  pin that had passed the lopsided grid sharpened, never weakened).
//
//  WHY THE OLD PIN MISSED THE CLAM HERO. The previous law (1) exempted the
//  HERO grids as a class — "their asymmetry IS the authored identity
//  gesture" — so the clam hero was never looked at, and (2) compared only the
//  PAINTED-CELL MASK of the small forms, so a grid whose outline and grooves
//  mirrored but whose shading leaned (the family's one-light-source L
//  high-left / m low-right, worn by a creature that is a symmetric shell)
//  passed as symmetric. That is exactly the class the operator saw: a bright
//  L wedge on the dome's left flank and a dark m falloff on its right, the
//  shell reading as tilted. The poison control below is that grid.
//
//  THE LAW, per grid the estate renders — the 13-wide awake art, the hero
//  awake art, the 11-wide mini, the 10×6 compact mark, and every authored
//  sleep pose — about the axis the RENDER centres on (the content-bounds
//  centre for the content-sliced hero grids, the grid centre for the
//  whole-rendered small forms):
//    §1 OUTLINE  — each row's painted-cell mask mirrors.
//    §2 ANATOMY  — the STRUCTURAL letters mirror position for position: the
//                  deep accent (C: grooves, ribs, limbs), the dark shade (D:
//                  notches, seams, interiors, eyestalks) and the eye letters
//                  (E/K/P as one class — the pupil's exact cell is the gaze's
//                  business at render). Lighting letters (L/m/M/%) are free
//                  to fall with a design's light source.
//    §3 FULL     — a grid registered FULLY MIRRORED (the clam, every form,
//                  awake and asleep: "everything static mirrors") mirrors
//                  letter for letter, shading included. critterGaze moves the
//                  K at render, never in the authored rest grid.
//    §4 SLOT     — a hero grid's content width shares the parity of the hero
//                  mounts' inner width (HERO_ART_COLS), so the slot centres it
//                  EXACTLY; a width that cannot is NAMED here, never fudged.
//  REGISTERED GESTURES are the only exemptions — per grid, per row, reason
//  stated: the authored asymmetric identity gestures. The registry is a
//  ratchet in both directions: an unregistered asymmetric row fails, and a
//  registered row that has become symmetric is a STALE registration and
//  fails too (prune it). The clam registers nothing.
//  RECEIPT — prints, per grid, rows × width, the axis and every row's
//  verdict: the numeric symmetry receipt.
// ============================================================================
import {
  CRITTERS,
  HERO_ART_COLS,
  heroContentBounds,
  markCompactArtFor,
  miniArtFor,
  sleepPoseFor,
} from '../../src/utils/cockpit/critterData.js'

let failures = 0
function check(label: string, ok: boolean, detail = ''): void {
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}

// ── the detectors ──────────────────────────────────────────────────────────

type AxisKind = 'content' | 'grid'

/** The mirror partner of column `c` about the render axis of `art`. */
function mirrorOf(art: readonly string[], kind: AxisKind): (c: number) => number {
  const width = Math.max(...art.map(r => r.length), 0)
  const [s, e] = kind === 'content' ? heroContentBounds([...art]) : [0, width]
  return (c: number) => s + e - 1 - c
}

/** The structural class of a legend letter (§2). */
function anatomyClass(ch: string): string {
  if (ch === '.') return '.'
  if (ch === 'C') return 'C'
  if (ch === 'D') return 'D'
  if (ch === 'E' || ch === 'K' || ch === 'P') return 'eye'
  return 'body'
}

type RowVerdict = { outline: boolean; anatomy: boolean; full: boolean }

function rowVerdict(row: string, mirror: (c: number) => number): RowVerdict {
  const at = (c: number): string => (c >= 0 && c < row.length ? row[c]! : '.')
  let outline = true
  let anatomy = true
  let full = true
  for (let c = 0; c < row.length; c++) {
    const a = at(c)
    const b = at(mirror(c))
    if ((a === '.') !== (b === '.')) outline = false
    if (anatomyClass(a) !== anatomyClass(b)) anatomy = false
    if (a !== b) full = false
  }
  return { outline, anatomy, full }
}

// ── the registry of authored gestures (the ONLY exemptions) ────────────────

type Gesture = { reason: string; rows: readonly number[] }

/** Rows an authored identity gesture leaves asymmetric — §1 and §2 exempt
 *  those rows and nothing else. Keyed `<critter> · <form>`; every entry is a
 *  fact about the grid TODAY (the stale-registration check keeps it so). */
const GESTURES: Readonly<Record<string, Gesture>> = {
  'crab · compact mark': { reason: 'the raised/low claw pose carried down from the hero', rows: [0, 1] },
  'crab · hero awake': {
    reason: 'the raised claw (open-out) against the low claw (open-down) — the crab\'s identity gesture',
    rows: [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17],
  },
  'crab · hero sleep': {
    reason: 'the settled crown (12 wide on a 23-wide shell) and the tucked claws/folded legs sit one column off the awake shell\'s axis',
    rows: [8, 12, 14, 15, 16, 17],
  },
  'octopus · hero awake': {
    reason: 'one arm raised beside the mantle — the octopus\'s identity gesture (the whole body leans into it, eyes included)',
    rows: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17],
  },
  'octopus · hero sleep': {
    reason: 'the slumped mantle and the coil of arms lean one column off the axis (row 15, the web band\'s falloff, happens to mirror)',
    rows: [8, 9, 10, 11, 12, 13, 14, 16, 17],
  },
  'jellyfish · hero awake': {
    reason: 'seven strands of genuinely varied length (the trailing tips fall off-axis by design); the eye clusters are translated, not mirrored — the sclera sits outboard on the left eye and inboard on the right (rows 4–5)',
    rows: [4, 5, 14, 16, 17],
  },
}

/** Grids that mirror LETTER FOR LETTER (§3): the clam, every form, awake and
 *  asleep — a symmetric shell lit from above wears symmetric shading — and
 *  THE WHOLE SQUARE TIER (chat-feel item 5): the geometric variant is
 *  mirrored by design, shading included, on every critter at both sizes.
 *  The squares register NO gesture rows at all. */
const FULL_MIRROR = new Set<string>([
  'clam · 13w awake',
  'clam · hero awake',
  'clam · mini awake',
  'clam · compact mark',
  'clam · 13w sleep',
  'clam · hero sleep',
  'clam · mini sleep',
  'crab · square',
  'crab · square dock',
  'octopus · square',
  'octopus · square dock',
  'jellyfish · square',
  'jellyfish · square dock',
  'clam · square',
  'clam · square dock',
])

// ── the law over one grid ──────────────────────────────────────────────────

function gridLaw(name: string, art: string[] | null | undefined, kind: AxisKind): void {
  if (!art || art.length === 0) {
    check(`${name}: grid present`, false, 'missing grid')
    return
  }
  const widths = new Set(art.map(r => r.length))
  check(`${name}: uniform width`, widths.size === 1, `widths=${[...widths].join(',')}`)
  const width = art[0]!.length
  const [s, e] = kind === 'content' ? heroContentBounds(art) : [0, width]
  const mirror = mirrorOf(art, kind)
  const gesture = GESTURES[name]
  const exempt = new Set(gesture?.rows ?? [])
  const verdicts = art.map(row => rowVerdict(row, mirror))
  // The numeric receipt: rows × width, the axis, every row's verdict.
  console.log(
    `  · ${name}: ${art.length} rows × ${width} wide · axis ${kind} [${s},${e}) centre ${((s + e - 1) / 2).toFixed(1)}` +
      ` · outline ${verdicts.filter(v => v.outline).length}/${art.length} · anatomy ${verdicts.filter(v => v.anatomy).length}/${art.length}` +
      ` · full ${verdicts.filter(v => v.full).length}/${art.length}` +
      (exempt.size ? ` · registered gesture rows ${[...exempt].join(',')}` : ''),
  )
  const outlineBad = verdicts.map((v, i) => (!v.outline && !exempt.has(i) ? i : -1)).filter(i => i >= 0)
  check(
    `${name}: §1 every row's OUTLINE mirrors (gesture rows exempt: ${exempt.size})`,
    outlineBad.length === 0,
    outlineBad.map(i => `row ${i}: ${JSON.stringify(art[i])}`).join(' · '),
  )
  const anatomyBad = verdicts.map((v, i) => (!v.anatomy && !exempt.has(i) ? i : -1)).filter(i => i >= 0)
  check(
    `${name}: §2 every row's ANATOMY (C/D/eye placement) mirrors`,
    anatomyBad.length === 0,
    anatomyBad.map(i => `row ${i}: ${JSON.stringify(art[i])}`).join(' · '),
  )
  if (FULL_MIRROR.has(name)) {
    const fullBad = verdicts.map((v, i) => (!v.full ? i : -1)).filter(i => i >= 0)
    check(
      `${name}: §3 every row mirrors LETTER FOR LETTER (shading included)`,
      fullBad.length === 0,
      fullBad.map(i => `row ${i}: ${JSON.stringify(art[i])}`).join(' · '),
    )
  }
  if (gesture) {
    // The registration is a fact about the grid TODAY: a registered row that
    // mirrors in outline AND anatomy no longer needs the exemption.
    const stale = gesture.rows.filter(i => verdicts[i]?.outline && verdicts[i]?.anatomy)
    check(`${name}: no STALE gesture registration (a registered row is still asymmetric)`, stale.length === 0, `rows ${stale.join(',')} mirror now — prune them`)
  }
  if (kind === 'content') {
    const contentWidth = e - s
    const exact = (HERO_ART_COLS - contentWidth) % 2 === 0
    console.log(`  · ${name}: content width ${contentWidth} in the ${HERO_ART_COLS}-col slot ⇒ ${exact ? 'centres EXACTLY' : `cannot centre exactly (${HERO_ART_COLS - contentWidth} spare columns split ${Math.floor((HERO_ART_COLS - contentWidth) / 2)}/${Math.ceil((HERO_ART_COLS - contentWidth) / 2)}) — named, not fudged`}`)
    if (FULL_MIRROR.has(name)) check(`${name}: §4 the content width centres EXACTLY in the ${HERO_ART_COLS}-col hero slot`, exact, `${contentWidth} wide`)
  }
}

console.log('sprite symmetry — the mirror law over every rest pose, every form')

check('the pool holds the four critters', CRITTERS.length === 4, `${CRITTERS.length}`)
for (const def of CRITTERS) {
  const name = def.name
  gridLaw(`${name} · 13w awake`, def.art, 'grid')
  gridLaw(`${name} · hero awake`, def.heroArt, 'content')
  gridLaw(`${name} · mini awake`, miniArtFor(name), 'grid')
  gridLaw(`${name} · compact mark`, markCompactArtFor(name), 'grid')
  gridLaw(`${name} · square`, def.square, 'grid')
  gridLaw(`${name} · square dock`, def.squareDock, 'grid')
  const artSleep = sleepPoseFor({ name }, 'art')
  if (artSleep) gridLaw(`${name} · 13w sleep`, artSleep.art, 'grid')
  const heroSleep = sleepPoseFor({ name }, 'hero')
  if (heroSleep) gridLaw(`${name} · hero sleep`, heroSleep.art, 'content')
  const miniSleep = sleepPoseFor({ name }, 'mini')
  if (miniSleep) gridLaw(`${name} · mini sleep`, miniSleep.art, 'grid')
}
check('every registered gesture names a grid the law walked', Object.keys(GESTURES).every(k => /^(crab|octopus|jellyfish|clam) · (13w awake|hero awake|mini awake|compact mark|13w sleep|hero sleep|mini sleep|square|square dock)$/.test(k)), Object.keys(GESTURES).join(' · '))
check('the clam registers NO gesture — every form mirrors whole', Object.keys(GESTURES).every(k => !k.startsWith('clam')))
check('the square tier registers NO gesture — the geometric variant mirrors whole (chat-feel item 5)', Object.keys(GESTURES).every(k => !k.includes('square')))

// ── poison controls: the law must BITE ──────────────────────────────────────
console.log('poison controls')
{
  const mirror13 = (c: number): number => 12 - c
  check('§1 detects a lopsided outline (self-test)', !rowVerdict('MM...........', mirror13).outline)
  check('§1 accepts a mirrored outline (self-test)', rowVerdict('.M..MM..M....', mirror13).outline === false && rowVerdict('.M...M...M...', mirror13).outline === false && rowVerdict('.M.MM.M.MM.M.', mirror13).outline)
  check('§2 detects a shifted groove under a mirrored outline (self-test)', rowVerdict('.MMCMMMMMMCM.', mirror13).outline && !rowVerdict('.MMCMMMMMMCM.', mirror13).anatomy)
  check('§2 accepts a mirrored groove pair (self-test)', rowVerdict('.MMCMMMMMCMM.', mirror13).anatomy)
  check('§3 detects leaning shading under mirrored outline + anatomy (self-test)', rowVerdict('.LMMCMMMCMMm.', mirror13).outline && rowVerdict('.LMMCMMMCMMm.', mirror13).anatomy && !rowVerdict('.LMMCMMMCMMm.', mirror13).full)
  check('§3 accepts a fully mirrored row (self-test)', rowVerdict('.mMMCMMMCMMm.', mirror13).full)

  // THE FIXTURE the operator saw: the pre-compact clam hero (18 rows, the
  // family's one-light-source shading — L high-left, m low-right). Its
  // outline and grooves mirror; its shading does not. The old law (heroes
  // exempt; masks only) passed it; §3 must trip on it — and §1/§2 must NOT,
  // which is the receipt that the miss was the shading class, not the
  // outline.
  const LEANING_CLAM_HERO: string[] = [
    '.........LLCCMM.........',
    '.......LLMMCCMMMm.......',
    '.....LLMMMCMMCMMMmm.....',
    '....LMMMMCMCCMCMMMmm....',
    '...LMMMMCMCMMCMCMMMmm...',
    '..LMMMMCMMCMMCMMCMMMmm..',
    '..MMMMCMMCMMMMCMMCMMmm..',
    '..MMMCMMMCMMMMCMMMCMmm..',
    '..MDMMDMMDMMMMDMMDMMDM..',
    '...DDDDDDDDDDDDDDDDDD...',
    '...DDDEEEDDDDDDEEEDDD...',
    '...DDDEKEDDDDDDEKEDDD...',
    '..%%%%%%%%%%%%%%%%%%%%..',
    '..MMCMMMCMMMMMMCMMMCmm..',
    '..MMMCMMMCMMMMCMMMCMmm..',
    '...MMMCMMMCMMCMMMCMmm...',
    '....mMMCMMMCCMMMCMmm....',
    '.....CCCCCCCCCCCCCC.....',
  ]
  const m = mirrorOf(LEANING_CLAM_HERO, 'content')
  const v = LEANING_CLAM_HERO.map(r => rowVerdict(r, m))
  check('poison: the pre-compact clam hero mirrors in OUTLINE on every row (the old mask law would pass it)', v.every(x => x.outline))
  check('poison: the pre-compact clam hero mirrors in ANATOMY on every row (grooves, notches, ribs, eyes)', v.every(x => x.anatomy))
  const leaning = v.map((x, i) => (!x.full ? i : -1)).filter(i => i >= 0)
  check('poison: §3 TRIPS on the pre-compact clam hero — its shading leans (the class the operator saw)', leaning.length >= 10, `leaning rows: ${leaning.join(',')}`)
  // A grid with a lopsided OUTLINE and one with a shifted GROOVE trip §1/§2.
  const LOPSIDED = LEANING_CLAM_HERO.map((r, i) => (i === 3 ? '....LMMMMCMCCMCMMMmmM...' : r))
  const lv = LOPSIDED.map(r => rowVerdict(r, mirrorOf(LOPSIDED, 'content')))
  check('poison: §1 TRIPS on a lopsided outline row', lv.some(x => !x.outline))
  const SHIFTED = LEANING_CLAM_HERO.map((r, i) => (i === 13 ? '..MMCMMMCMMMMMMCMMCMmm..' : r))
  const sv = SHIFTED.map(r => rowVerdict(r, mirrorOf(SHIFTED, 'content')))
  check('poison: §2 TRIPS on a shifted rib (outline intact)', sv[13]!.outline && !sv[13]!.anatomy)
}

if (failures > 0) {
  console.error(`\n❌ ${failures} SPRITE-SYMMETRY PROOF(S) FAILED`)
  process.exit(1)
}
console.log('\n✅ ALL SPRITE-SYMMETRY PROOFS PASS')
