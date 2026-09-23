#!/usr/bin/env bun
import {
  CRITTERS,
  heroContentBounds,
  miniArtFor,
  sleepPoseFor,
} from '../../src/utils/cockpit/critterData.js'

let failures = 0
function check(label: string, ok: boolean, detail = ''): void {
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}


type AxisKind = 'content' | 'grid'

function mirrorOf(art: readonly string[], kind: AxisKind): (c: number) => number {
  const width = Math.max(...art.map(r => r.length), 0)
  const [s, e] = kind === 'content' ? heroContentBounds([...art]) : [0, width]
  return (c: number) => s + e - 1 - c
}

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


type Gesture = { reason: string; rows: readonly number[] }

const GESTURES: Readonly<Record<string, Gesture>> = {}

const FULL_MIRROR = new Set<string>([
  'clam · 13w awake',
  'clam · mini awake',
  'clam · 13w sleep',
  'clam · mini sleep',
  'crab · square dock',
  'octopus · square dock',
  'jellyfish · square dock',
  'clam · square dock',
])


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
    const stale = gesture.rows.filter(i => verdicts[i]?.outline && verdicts[i]?.anatomy)
    check(`${name}: no STALE gesture registration (a registered row is still asymmetric)`, stale.length === 0, `rows ${stale.join(',')} mirror now — prune them`)
  }
}

console.log('sprite symmetry — the mirror law over every rest pose, every form')

check('the pool holds the four critters', CRITTERS.length === 4, `${CRITTERS.length}`)
for (const def of CRITTERS) {
  const name = def.name
  gridLaw(`${name} · 13w awake`, def.art, 'grid')
  gridLaw(`${name} · mini awake`, miniArtFor(name), 'grid')
  gridLaw(`${name} · square dock`, def.squareDock, 'grid')
  const artSleep = sleepPoseFor({ name }, 'art')
  if (artSleep) gridLaw(`${name} · 13w sleep`, artSleep.art, 'grid')
  const miniSleep = sleepPoseFor({ name }, 'mini')
  if (miniSleep) gridLaw(`${name} · mini sleep`, miniSleep.art, 'grid')
}
check('every registered gesture names a grid the law walked', Object.keys(GESTURES).every(k => /^(crab|octopus|jellyfish|clam) · (13w awake|mini awake|13w sleep|mini sleep|square dock)$/.test(k)), Object.keys(GESTURES).join(' · '))
check('the clam registers NO gesture — every form mirrors whole', Object.keys(GESTURES).every(k => !k.startsWith('clam')))
check('the square tier registers NO gesture — the geometric variant mirrors whole (chat-feel item 5)', Object.keys(GESTURES).every(k => !k.includes('square')))

console.log('poison controls')
{
  const mirror13 = (c: number): number => 12 - c
  check('§1 detects a lopsided outline (self-test)', !rowVerdict('MM...........', mirror13).outline)
  check('§1 accepts a mirrored outline (self-test)', rowVerdict('.M..MM..M....', mirror13).outline === false && rowVerdict('.M...M...M...', mirror13).outline === false && rowVerdict('.M.MM.M.MM.M.', mirror13).outline)
  check('§2 detects a shifted groove under a mirrored outline (self-test)', rowVerdict('.MMCMMMMMMCM.', mirror13).outline && !rowVerdict('.MMCMMMMMMCM.', mirror13).anatomy)
  check('§2 accepts a mirrored groove pair (self-test)', rowVerdict('.MMCMMMMMCMM.', mirror13).anatomy)
  check('§3 detects leaning shading under mirrored outline + anatomy (self-test)', rowVerdict('.LMMCMMMCMMm.', mirror13).outline && rowVerdict('.LMMCMMMCMMm.', mirror13).anatomy && !rowVerdict('.LMMCMMMCMMm.', mirror13).full)
  check('§3 accepts a fully mirrored row (self-test)', rowVerdict('.mMMCMMMCMMm.', mirror13).full)

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
