#!/usr/bin/env bun

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { checker } from '../engine-durability/harness.ts'

const t = checker()
const cd = await import('../../src/utils/cockpit/critterData.js')

const CRAB = cd.CRITTERS[0]!

t.section('§1 — grid law: widths + alphabet')
{
  const alphaOk = (rows: readonly string[], allowed: string): boolean =>
    rows.every(r => [...r].every(ch => allowed.includes(ch)))
  t.check('crab art is 13×12, alphabet {. M C P L}', CRAB.art.length === 12 && CRAB.art.every(r => r.length === 13) && alphaOk(CRAB.art, '.MCPL'), 'crab')
  t.check('crab mini (redesign v1) is 11×6', cd.miniArtFor('crab').length === 6 && cd.miniArtFor('crab').every(r => r.length === 11), 'crab mini')
}

t.section('§2 — the crab belly rows are byte-preserved')
{
  t.check('rows 8-9 are the shipped LL band', CRAB.art[8] === '..LLLLLLLLL..' && CRAB.art[9] === '..LLLLLLLLL..', JSON.stringify([CRAB.art[8], CRAB.art[9]]))
}

t.section('§3 — the species law: distinguishing features get P, never D')
{
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
      /critterDefForKey\(identity\.markKey\)/.test(header) &&
      !/critterDefForKey\(\s*['"]jellyfish['"]\s*\)/.test(header),
    'selection-derived mark',
  )
  t.check(
    'the header mounts the square-dock grid through the square form (named row #1)',
    /<CritterArt def=\{markDef\} square /.test(header) &&
      !/square:\s*[A-Za-z]/.test(header),
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
  const crabArt = cd.CRITTERS[0]!.art
  const eyePairTop = crabArt.findIndex(
    (r, i) => i % 2 === 0 && r.includes('P') && (crabArt[i + 1]?.includes('P') ?? false),
  )
  t.check('the crab flat grid keeps a P-over-P dome eye pair', eyePairTop >= 0, `pair top row ${eyePairTop}`)
  t.check('the pose-aim seam stayed deleted (no eyeRowOverride revival)', !/eyeRowOverride/.test(String((cd as Record<string, unknown>)['CRAB_EYE_ROWS'] ?? '')) && (cd as Record<string, unknown>)['CRAB_EYE_ROWS'] === undefined)
}

t.section('§9 — the header STILL: the square dock at the header, one surface only)')
{
  process.env['MERCURY_CONFIG_DIR'] = (await import('node:fs')).mkdtempSync(
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
    }
    const still = await renderToString(React.createElement(CritterArt, { def: headerDef, square: true } as never), 60)
    const rows = still.split('\n').filter(l => l.length > 0)
    t.check(`${def.name}: the header mark is the 3-row square-dock still`, rows.length === cd.SQUARE_DOCK_ART_LINES, `${rows.length} rows`)
    const inked = rows.map(r => r.trimEnd().length)
    const authored = cd.squareDockArtFor(def.name).map(r => r.replace(/\.+$/, '').length)
    t.check(`${def.name}: the still paints the def's own dock grid (row extents match the authored rows)`, inked.every((w, i) => w === Math.max(authored[2 * i] ?? 0, authored[2 * i + 1] ?? 0)), `${inked.join(',')} vs ${authored.join(',')}`)
    const glowed = await renderToAnsiString(React.createElement(CritterArt, { def: headerDef, square: true, glowToward: '#F2C9A0' } as never), 60)
    const plain = await renderToAnsiString(React.createElement(CritterArt, { def: headerDef, square: true } as never), 60)
    t.check(`${def.name}: the glow ramp still re-inks the art (colour bytes move, glyphs hold)`, glowed !== plain && (await renderToString(React.createElement(CritterArt, { def: headerDef, square: true, glowToward: '#F2C9A0' } as never), 60)) === still)
  }
}

t.finish('prove-concourse-critter')
