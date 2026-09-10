#!/usr/bin/env bun
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '0.0.0-prover' }

const ROOT = join(import.meta.dir, '..', '..')
const read = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8')

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}

const LADDER: Array<[number, number]> = [
  [64, 12],
  [80, 24],
  [100, 30],
  [100, 34],
  [120, 40],
  [142, 38],
  [200, 60],
  [205, 53],
]

console.log('§1 the face: every ladder size + the shed to one honest line')
{
  const { createSplashCore } = await import('../../assets/splash/splash-core.mjs')
  const core = createSplashCore({ nocolor: true, truecolor: false, accent: 'crimson' }) as {
    composeLockup: (...a: unknown[]) => { lines: string[] }
  }
  const strip = (x: string): string => x.replace(/\x1b\[[0-9;]*m/g, '')
  const face = (c: number, r: number): string[] =>
    core
      .composeLockup(c, r, {
        cardRows: [
          { icon: '▸', label: 'New Session', ctx: 'fresh chat in this repo' },
          { icon: '↻', label: 'Continue Last Session', ctx: '5m ago' },
        ],
        cardSel: 0,
        hintSegments: [{ key: '↵ ', label: 'start', tone: 'ivory' }],
        tinyHint: '↵ start',
        stripLines: () => [],
      })
      .lines.map(strip)
  let sound = true
  for (const [c, r] of [...LADDER, [40, 8], [24, 3], [16, 2], [8, 1]] as Array<[number, number]>) {
    const lines = face(c, r)
    if (lines.length === 0) sound = false
    if (lines.some(l => l.length > c)) sound = false
  }
  check('never empty, never a line wider than the terminal — ladder + far below', sound)
  check('the deepest tier is the mark alone (identity last)', face(8, 1).some(l => l.includes('(>_)')))
}

console.log('§2 the menu: warn iff below its floor; the exit named; fits by construction')
{
  const { createSplashCore } = await import('../../assets/splash/splash-core.mjs')
  const core = createSplashCore({ nocolor: true, truecolor: false, accent: 'crimson' }) as {
    composeBootMenu: (...a: unknown[]) => { lines: string[] }
  }
  const strip = (x: string): string => x.replace(/\x1b\[[0-9;]*m/g, '')
  const entries = Array.from({ length: 12 }, (_, i) => ({
    label: `Setting row ${i + 1}`,
    valueLabel: 'on',
    valueIsDefault: false,
    group: i < 6 ? 'trust' : 'memory',
    pinnedVal: null,
    inert: false,
    summary: `summary ${i + 1}`,
  }))
  const m = {
    entries,
    selIdx: 3,
    title: 'boot menu',
    legend: '↑↓ choose · ↵ cycle · esc back',
    summaryRows: [
      { key: 'Profile', value: 'defaults' },
      { key: 'Sessions', value: '2 live' },
    ],
    environment: { model: 'Opus 5', critter: 'Octopus', critterHue: '#B07BE0', dirBase: 'orchard-src', dirTail: '' },
    statusRight: 'saved · r3',
  }
  const menu = (c: number, r: number): string[] => core.composeBootMenu(c, r, m).lines.map(strip)
  check('the floor boundary is exact: warn at 63×13 and 64×12, none at 64×13', menu(63, 13).some(l => l.includes('wants at least')) && menu(64, 12).some(l => l.includes('wants at least')) && !menu(64, 13).some(l => l.includes('wants at least')))
  let sound = true
  for (const [c, r] of [...LADDER, [50, 8], [40, 3], [30, 1]] as Array<[number, number]>) {
    const lines = menu(c, r)
    if (lines.length > r && r < 13) sound = false
    if (lines.some(l => l.length > c)) sound = false
    if (!lines.some(l => /esc back|esc/.test(l))) sound = false
  }
  check('every size: lines fit below the floor, nothing overwide, the exit named', sound)
}

console.log('§3 the concourse remains functional below the former floor')
{
  const { resolveConcourseProfile, switchboardGeometry } = await import('../../src/components/concourse/ConcourseLayout.tsx')
  for (const [cols, rows] of [[1, 1], [2, 2], [40, 10], [60, 16], [79, 22], [80, 21], [80, 24], [120, 24]]) {
    check(`${cols}x${rows}: a real layout, never a refusal profile`, resolveConcourseProfile(cols!, rows!) === (cols! >= 120 && rows! >= 24 ? 'wide' : 'stacked'))
    for (const region of ['coordinator', 'list', 'live', 'rail'] as const) {
      const g = switchboardGeometry(cols!, rows!, 2, 4, 2, 1, region === 'coordinator' ? 'coordinator' : 'mirror', 0, region)
      check(`${cols}x${rows} ${region}: nonnegative dimensions`, g.interior >= 0 && g.mainRows >= 0 && g.listContentRows >= 0 && g.liveComposerRows >= 0)
      if (g.constrained) {
        const band = region === 'coordinator' ? g.coordBand : region === 'list' ? g.listBand : region === 'live' ? g.liveComposerBand : [1, g.railRows]
        check(`${cols}x${rows} ${region}: the focused region receives an in-bounds row`, band[0]! >= 1 && band[1]! >= band[0]! && band[1]! <= rows!)
      }
    }
  }
  const layout = read('src/components/concourse/ConcourseLayout.tsx')
  check('no application-size refusal remains in the concourse', !layout.includes("return 'too-small'") && !layout.includes('terminal too small for'))
}

console.log('§4 split, chrome and overlay commitments hold at the ladder')
{
  const split = await import('../../src/components/concourse/splitView.ts')
  check(`split: 121×${split.SPLIT_MIN_ROWS} is the simultaneous two-pane budget`, !split.splitAvailableAt(120, split.SPLIT_MIN_ROWS) && !split.splitAvailableAt(121, split.SPLIT_MIN_ROWS - 1) && split.splitAvailableAt(121, split.SPLIT_MIN_ROWS))
  const { LAYOUT_BREAKPOINTS } = await import('../../src/hooks/useLayoutTier.ts')
  check(
    'chrome: the ratified numbers stand (cockpit 100×26 · deck 22 rows · the 64 frame floor)',
    LAYOUT_BREAKPOINTS.cockpitMin === 100 && LAYOUT_BREAKPOINTS.cockpitMinRows === 26 && LAYOUT_BREAKPOINTS.deckMinRows === 22 && LAYOUT_BREAKPOINTS.frameQuotaMin === 64,
  )
  const { viewportRows } = await import('../../src/components/mercury-ui/geometry.ts')
  check('overlays: min never manufactures rows the terminal lacks', viewportRows(3, { reserve: 5, min: 4 }) === 0 && viewportRows(12, { reserve: 4, min: 4 }) === 8)
}

console.log(failures === 0 ? '\nsize-ladder: GREEN' : `\nsize-ladder: ${failures} RED`)
process.exit(failures === 0 ? 0 : 1)
