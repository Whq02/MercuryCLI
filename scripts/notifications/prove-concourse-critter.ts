#!/usr/bin/env bun
// ============================================================================
//  scripts/notifications/prove-concourse-critter.ts — (the field fold,
//  + §F4): the Concourse-resident hermit + the crab redesign.
//
//  §1  grid law: widths + alphabet machine-asserted (the field's own bar).
//  §2  the crab belly rows are byte-preserved.
//  §3  the adopted species law: distinguishing features get P (pop), never D.
//  §4 —
//      wink / refused / molt; the settled grid is never mutated.
//  §5  the pool marks are mutually unique.
//  §6  the C shell legend: authored fallback = hueDeep; the render-time
//      re-binding seam (legendOverride) exists at the ONE painter.
//  §7  registration laws: the rotation NEVER grows, and — since the recut
// no surface-bound critter is key-resolvable at all; the
//      Concourse imports its resident directly and a retired key takes the
//      bounded fallback. The SEVENTH divergence class is still recorded
//      BEFORE any parity prover runs.
//  §8  the crab pose-aim targets the redesigned eye pair.
// ============================================================================

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { checker } from '../engine-durability/harness.ts'

const t = checker()
const cd = await import('../../src/utils/cockpit/critterData.js')

const CRAB = cd.CRITTERS[0]!

t.section('§1 — grid law: widths + alphabet')
{
  const alphaOk = (rows: readonly string[], allowed: string): boolean =>
    rows.every(r => [...r].every(ch => allowed.includes(ch)))
  // The resident's small grid is reached by NAME now, not
  t.check('crab art is 13×12, alphabet {. M C P L}', CRAB.art.length === 12 && CRAB.art.every(r => r.length === 13) && alphaOk(CRAB.art, '.MCPL'), 'crab')
  t.check('crab mini (redesign v1) is 11×6', cd.miniArtFor('crab').length === 6 && cd.miniArtFor('crab').every(r => r.length === 11), 'crab mini')
}

t.section('§2 — the crab belly rows are byte-preserved')
{
  t.check('rows 8-9 are the shipped LL band', CRAB.art[8] === '..LLLLLLLLL..' && CRAB.art[9] === '..LLLLLLLLL..', JSON.stringify([CRAB.art[8], CRAB.art[9]]))
}

t.section('§3 — the species law: distinguishing features get P, never D')
{
  // The recut gave the claw a real PINCER: prong · gap · prong
  // over a closed hand, so the pair renders ▀▄▀ — the tips are still the POP
  // the species law demands, and the gap between them is the whole point.
  t.check('crab claw tips are P pops with the pincer gap (row 0)', CRAB.art[0] === 'P.P.......P.P', CRAB.art[0]!)
  t.check('the pincer hand closes under the prongs (row 1)', CRAB.art[1] === 'MMM.......MMM', CRAB.art[1]!)
  t.check('crab eyes are P inside the dome (rows 4-5)', CRAB.art[4] === '.MMPMMMMMPMM.' && CRAB.art[5] === CRAB.art[4], CRAB.art[4]!)
  t.check('crab mini pincers are P pops', cd.miniArtFor('crab')[2] === 'PMMPMMMPMMP', cd.miniArtFor('crab')[2]!)
}

t.section('§5 — the pool marks are mutually unique')
{
  const render = (m: { pre: string; core: string; post: string }): string => m.pre + m.core + m.post
  const shipped = cd.CRITTERS.map(d => render(d.mark))
  t.check('no two pool marks collide', new Set(shipped).size === shipped.length, JSON.stringify(shipped))
}

t.section('§6 — the C shell legend binding')
{
  const painter = await Bun.file('src/components/mercury-ui/CritterArt.tsx').text()
  t.check(
    'the ONE painter carries the legendOverride re-binding seam (peek-identity shell)',
    /legendOverride\?: Readonly<Record<string, string>>/.test(painter) && /legendOverride\?\.\[ch\]/.test(painter),
    'seam present',
  )
}

t.section('§7 — registration laws + the SEVENTH divergence class')
{
  t.check('the rotation NEVER grows (4 active)', cd.CRITTER_COUNT === 4, String(cd.CRITTER_COUNT))
  // The recut INVERTED this pin. The resident would otherwise be reachable
  // as 'hermit' / 'hermit crab' through the shared key resolver, which is what
  // let retired art sit in the estate looking live. The contract is now the
  // opposite: NO non-pool key resolves, the Concourse imports HERMIT_DEF
  // directly, and a stale name takes the bounded fallback instead of a crash.
  t.check(
    'the hermit is NOT key-resolvable (surface-bound, imported directly)',
    !cd.isPoolCritterKey('hermit') &&
      !cd.isPoolCritterKey('hermit crab'),
    'not resolvable',
  )
  t.check(
    'a retired hermit key takes the bounded fallback to the pool default',
    cd.critterDefForKey('hermit crab').name === cd.critterDefForKey(cd.DEFAULT_CRITTER_KEY).name,
    cd.critterDefForKey('hermit crab').name,
  )
  // RE-CUT: the concourse critter is
  // now THEME-AWARE — the resident and the header mark BOTH derive from the
  // session's selection owner (useSessionAccent → critterDefForKey), which
  // supersedes both prior shapes: the fixed hermit empty-state mount (LANE
  // CR's direct-import pin) and SR-064's fixed jellyfish header. The hermit
  // may still not be reachable BY KEY (asserted above), and its art stays
  // authored as a parked asset (deletion is a named deferral).
  const screen = await Bun.file('src/components/concourse/ConcourseScreen.tsx').text()
  t.check(
    'the zero-sessions resident derives from the selection owner (theme-aware, never a fixed creature)',
    /useSessionAccent\(\)/.test(screen) &&
      /critterDefForKey\(residentAccent\.key\)/.test(screen) &&
      !/HERMIT_DEF/.test(screen),
    'selection-derived resident',
  )
  const header = await Bun.file('src/components/concourse/ConcourseHeader.tsx').text()
  t.check(
    'the header mark derives from the SAME selection owner (the operator-ruled theme-aware set)',
    /useSessionAccent\(\)/.test(header) &&
      /squareDockArtFor\(identity\.markKey\)/.test(header) &&
      !/critterDefForKey\(\s*['"]jellyfish['"]\s*\)/.test(header),
    'selection-derived mark',
  )
  // The operator's screenshot ask: the header wears the
  // SQUARE family — the 11×6 dock grid rebound onto the def's square slot,
  // rendered through CritterArt's square form (MiniCritter's own dock
  // grammar). The old 10×6 markCompact mount may NOT silently return.
  t.check(
    'the header mounts the square-dock grid through the square form (named row #1)',
    /square:\s*squareDockArtFor\(identity\.markKey\)/.test(header) &&
      /<CritterArt def=\{markDef\} square /.test(header) &&
      !/markCompactArtFor/.test(header),
    'square-dock mount',
  )
  t.check(
    'the concourse only FOLLOWS the selection — no setter, no persist call on this surface',
    !/setSessionCritter|persistSessionCritter/.test(screen) && !/setSessionCritter|persistSessionCritter/.test(header),
    'follow-only',
  )
  const seed = await import('./concourseReferenceSeed.ts')
  t.check(
    'CONCOURSE_REFERENCE_DIVERGENCES carries the SEVENTH class (resident-critter) BEFORE any parity prover',
    // SANITY FORK #2 P3: the register-before-parity ratchet bites again —
    // the CLOSED current set is exactly EIGHT; a ninth class must come
    // back here and move this pin deliberately.
    seed.CONCOURSE_REFERENCE_DIVERGENCES.length === 8 && /resident-critter/.test(seed.CONCOURSE_REFERENCE_DIVERGENCES[6] ?? ''),
    String(seed.CONCOURSE_REFERENCE_DIVERGENCES.length),
  )
  t.check(
    'and the EIGHTH (coordinator-tone: amber reserved for attention)',
    /coordinator-tone/.test(seed.CONCOURSE_REFERENCE_DIVERGENCES[7] ?? ''),
    seed.CONCOURSE_REFERENCE_DIVERGENCES[7]?.slice(0, 40),
  )
}

t.section('§8 — the crab dome eyes are authored art (the pose-aim seam is gone)')
{
  // CRAB_EYE_ROWS + CritterArt's eyeRowOverride were
  // deleted — the Clawd pose-aim seam had zero consumers, and its only
  // residual effect was CONSTRAINING the crab grid (rows 4/5 byte-identical
  // for an override nothing sent). The surviving contract is the art itself:
  // the dome carries a P-pair eye on a half-block row-pair, so the eye seam
  // paints real pupils.
  const crabArt = cd.CRITTERS[0]!.art
  const eyePairTop = crabArt.findIndex(
    (r, i) => i % 2 === 0 && r.includes('P') && (crabArt[i + 1]?.includes('P') ?? false),
  )
  t.check('the crab flat grid keeps a P-over-P dome eye pair', eyePairTop >= 0, `pair top row ${eyePairTop}`)
  t.check('the pose-aim seam stayed deleted (no eyeRowOverride revival)', !/eyeRowOverride/.test(String((cd as Record<string, unknown>)['CRAB_EYE_ROWS'] ?? '')) && (cd as Record<string, unknown>)['CRAB_EYE_ROWS'] === undefined)
}

t.section('§9 — the theme-aware compact mark SET (CR-3, operator addition)')
{
  // The 10×6 compact mark SET stays AUTHORED (all four pool critters in the
  // same compact grammar) though the header re-sourced to the square dock
  // — deletion is a named deferral, so the set's
  // own laws keep holding: uniform geometry, legend-mapped
  // colours, a real iris pair per creature, distinct silhouettes, and the
  // bounded resolver landing unknowns on the pool default.
  const MARK_W = 10
  const MARK_ROWS = 6
  const marks = cd.CRITTERS.map(d => [d.name, cd.markCompactArtFor(d.name)] as const)
  for (const [name, art] of marks) {
    t.check(`${name} mark: ${MARK_W}×${MARK_ROWS} uniform`, art.length === MARK_ROWS && art.every(r => r.length === MARK_W))
    const def = cd.critterDefForKey(name)
    const chars = new Set(art.join('').split('').filter(c => c !== '.'))
    t.check(
      `${name} mark: every char maps in cellColor`,
      [...chars].every(c => /^#[0-9a-f]{6}$/i.test(cd.cellColor(def, c) ?? '')),
      [...chars].join(''),
    )
    // A real iris: at least one P-over-P column pair (the eye seam's cell).
    let iris = false
    for (let r = 0; r + 1 < art.length; r += 2) {
      for (let c = 0; c < MARK_W; c++) {
        if (art[r]![c] === 'P' && art[r + 1]![c] === 'P') iris = true
      }
    }
    t.check(`${name} mark: carries a real iris pair`, iris)
  }
  t.check(
    'the four marks are four DISTINCT silhouettes',
    new Set(marks.map(([, art]) => art.join('\n'))).size === 4,
  )
  t.check(
    'the mark resolver is bounded — unknown and unset land on the pool default',
    cd.markCompactArtFor('no-such-creature').join('\n') === cd.markCompactArtFor(cd.DEFAULT_CRITTER_KEY).join('\n') &&
      cd.markCompactArtFor(undefined).join('\n') === cd.markCompactArtFor(cd.DEFAULT_CRITTER_KEY).join('\n'),
  )
  t.check(
    "the retired 'mantis' spellings resolve to the clam's mark (read-side successor)",
    cd.markCompactArtFor('mantis').join('\n') === cd.markCompactArtFor('clam').join('\n') &&
      cd.markCompactArtFor('mantis shrimp').join('\n') === cd.markCompactArtFor('clam').join('\n'),
  )
}

t.section('§10 — the header STILL: the square dock at the header, one surface only)')
{
  // The composed proof of the named row: the header's mark — the def spread
  // + accent tint + the square-dock rebind, rendered through CritterArt's
  // square form exactly as ConcourseHeader mounts it — paints BYTE-EQUAL
  // plain rows to the deck dock's own mount (MiniCritter's miniDef shape)
  // for every pool critter. The glow ramp changes colour bytes only, never
  // glyphs; the retired markCompact composition is demonstrably a different
  // picture, so a silent revert cannot read as "close enough".
  process.env['MERCURY_CONFIG_DIR'] ??= (await import('node:fs')).mkdtempSync(
    (await import('node:path')).join((await import('node:os')).tmpdir(), 'concourse-critter-still-'),
  )
  process.env['FORCE_COLOR'] = '3'
  delete process.env['NO_COLOR']
  process.env['MERCURY_CRITTER_GAZE'] = '0'
  const { enableConfigs } = await import('../../src/utils/config/globalConfig.js')
  enableConfigs()
  const React = (await import('react')).default
  const { renderToString, renderToAnsiString } = await import('../../src/utils/staticRender.tsx')
  const { CritterArt } = await import('../../src/components/mercury-ui/CritterArt.js')
  for (const def of cd.CRITTERS) {
    const headerDef = {
      ...cd.critterDefForKey(def.name),
      hue: def.hue,
      hueDeep: def.hueDeep,
      square: cd.squareDockArtFor(def.name),
    }
    const still = await renderToString(React.createElement(CritterArt, { def: headerDef, square: true } as never), 60)
    const dock = await renderToString(React.createElement(CritterArt, { def: { ...cd.critterDefForKey(def.name), hue: def.hue, hueDeep: def.hueDeep, square: cd.squareDockArtFor(def.name) }, square: true } as never), 60)
    const rows = still.split('\n').filter(l => l.length > 0)
    t.check(`${def.name}: the header mark is the 3-row square-dock still`, rows.length === 3, `${rows.length} rows`)
    t.check(`${def.name}: header mark ≡ deck dock (one square family, byte-equal plain rows)`, still === dock)
    const oldMark = await renderToString(React.createElement(CritterArt, { def: { ...cd.critterDefForKey(def.name), art: cd.markCompactArtFor(def.name) } } as never), 60)
    t.check(`${def.name}: the retired markCompact composition is a DIFFERENT picture`, still !== oldMark)
    const glowed = await renderToAnsiString(React.createElement(CritterArt, { def: headerDef, square: true, glowToward: '#F2C9A0' } as never), 60)
    const plain = await renderToAnsiString(React.createElement(CritterArt, { def: headerDef, square: true } as never), 60)
    t.check(`${def.name}: the glow ramp still re-inks the art (colour bytes move, glyphs hold)`, glowed !== plain && (await renderToString(React.createElement(CritterArt, { def: headerDef, square: true, glowToward: '#F2C9A0' } as never), 60)) === still)
  }
  // ONE SURFACE ONLY (the operator: "only that one gets changed and
  // targeted"): markCompactArtFor keeps ZERO product readers — the authored
  // set stays parked. Any new src mount must come back here deliberately.
  const glob = new Bun.Glob('src/**/*.{ts,tsx}')
  const readers: string[] = []
  for await (const p of glob.scan('.')) {
    if (p.endsWith('utils/cockpit/critterData.ts')) continue
    const body = await Bun.file(p).text()
    if (body.includes('markCompactArtFor')) readers.push(p)
  }
  t.check('markCompactArtFor has ZERO src readers (the set stays authored, parked)', readers.length === 0, readers.join(', ') || 'none')
}

t.finish('prove-concourse-critter')
