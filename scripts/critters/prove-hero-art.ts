#!/usr/bin/env bun
// prove-hero-art.ts — integrity of the AUTHORED hero grids (the
// replacement for the PNG bakes). Locks the family invariants AND the operator's
// white-dot bug class: every rendered color derives from the def's own hue via
// the legend, and the ONLY near-white a critter may carry is the deliberate
// IVORY eye/tip cream — a resample-style stray white is unrepresentable.
import {
  CRITTERS,
  HERO_ART_COLS,
  cellColor,
  heroBlinkRows,
  type CritterDef,
} from '../../src/utils/cockpit/critterData.js'

let fail = 0
const t = (name: string, ok: boolean, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) fail = 1
}

const LEGEND = new Set(['.', 'M', 'm', 'D', 'C', 'L', '%', 'E', 'K'])
// The POOL, and only the pool. These are the FAMILY
// invariants of the pool's hero language — the shared legend, the cream-eye
// treatment, the %-belly band — and the Concourse resident deliberately does
// not speak it (it carries a P body-shine and no belly band, because its
// identity is the shell). It would otherwise be the dragon standing in this list; with
// the dragon retired, the honest membership is the four critters that share
// the language, and the resident keeps its own grid law in
// scripts/notifications/prove-concourse-critter.ts §1.
const ALL: CritterDef[] = [...CRITTERS]


t('every pool critter carries heroArt', ALL.every(d => (d.heroArt?.length ?? 0) > 0))

for (const def of ALL) {
  const art = def.heroArt ?? []
  t(`${def.name}: uniform ${HERO_ART_COLS}-wide rows`, art.every(r => r.length === HERO_ART_COLS))
  const chars = new Set(art.join(''))
  t(`${def.name}: legend chars only`, [...chars].every(c => LEGEND.has(c)), [...chars].filter(c => !LEGEND.has(c)).join(''))
  t(`${def.name}: no control chars`, art.every(r => [...r].every(c => c.codePointAt(0)! >= 0x20)))
  t(`${def.name}: every non-empty char maps in cellColor`,
    [...chars].filter(c => c !== '.').every(c => /^#[0-9a-f]{6}$/i.test(cellColor(def, c) ?? '')))
  t(`${def.name}: has the cream-eye language`, chars.has('E') && chars.has('K'))
  // The % band is SPECIES ANATOMY, not a family constant (operator ruling):
  // the crab's belly, the jellyfish's skirt rim and the clam's
  // mantle wear it; the octopus's mantle is UNIFORM — its old full-width band
  // read as a stray highlight stripe at the berth and was struck. The two-way
  // band registry lives in prove-critter-look-census; this family pin holds
  // exactly the ruling.
  t(`${def.name}: band anatomy per the ruling`, chars.has('%') === (def.name !== 'octopus'))
  // The white-dot class, dead by construction: collect every color the grid can
  // paint; any channel-min > 220 (near-white) must be EXACTLY the IVORY cream.
  const nearWhites = new Set<string>()
  for (const c of chars) {
    const hex = cellColor(def, c)
    if (!hex) continue
    const [r, g, b] = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16))
    if (Math.min(r!, g!, b!) > 220) nearWhites.add(`${c}:${hex.toLowerCase()}`)
  }
  t(`${def.name}: near-white = deliberate cream only`,
    [...nearWhites].every(v => v.startsWith('E:#ede8dd')), [...nearWhites].join(','))
}

// ---- the blink transform (the hero's alive-cue) --------------------------
for (const def of ALL) {
  const blink = heroBlinkRows(def.heroArt!)
  t(`${def.name}: blink preserves geometry`, blink.length === def.heroArt!.length && blink.every((r, i) => r.length === def.heroArt![i]!.length))
  t(`${def.name}: blink closes every pupil`, !blink.join('').includes('K'))
}
// The NON-EYE CREAM class, stated generally. It used to
// be pinned through the dragon, whose horn tips were the family's only cream
// that wasn't an eye; with the dragon retired the invariant is asserted where
// it actually lives — heroBlinkRows lids a row ONLY when that row or its pair
// carries a K, so any row-pair without one must come back byte-identical. That
// keeps the guard alive for the next sprite that authors a cream tip.
for (const def of ALL) {
  const art = def.heroArt!
  const blink = heroBlinkRows(art)
  const untouched = art.every((row, i) => {
    const isEyePair = row.includes('K') || (art[i ^ 1]?.includes('K') ?? false)
    return isEyePair || blink[i] === row
  })
  t(`${def.name}: a blink touches ONLY the eye row-pair`, untouched)
  const eyeRow = art.findIndex(r => r.includes('K'))
  t(
    `${def.name}: the eyes DO close`,
    eyeRow >= 0 && blink[eyeRow] !== art[eyeRow] && !blink[eyeRow]!.includes('E'),
    `eye row ${eyeRow}`,
  )
}

console.log(fail ? '❌ HERO-ART RED' : '✅ HERO-ART GREEN')
process.exit(fail)
