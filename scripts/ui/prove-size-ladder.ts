#!/usr/bin/env bun
// ============================================================================
//  scripts/ui/prove-size-ladder.ts — THE RATIFIED SIZE LADDER (the
//  operator's floor word). The law, in their words:
//  "it should give a warning, but it should always be functional… it
//  shouldn't lock the user out at that size… bare minimum functional."
//  WARN, NEVER WALL — the preference order at every size:
//    works-degraded-with-warning  >  refusal-frame  >  one-line tier,
//  the way out LIVE at every tier, recovery instant on resize.
//
//  The ladder: 64×12 (the product floor) · 80×24 · 100×30 · 120×40 ·
//  200×60 + the capture sizes 80×24 · 100×34 · 142×38 · 205×53. Per-screen
//  commitments (each driven through its PURE owner):
//    face: every size (tier shed to one line — never empty, never wider);
//    boot menu + MCPs & Skills: 64×13 operating floor; warn-then-micro
//      below (prove-splash-units §11 drives the deep ladder; this ratchet
//      holds the invariants at the shared sizes);
//    concourse: THE registered refusal-frame screen (80×24) — the ONE
//      lawful full-replacement refusal, way out live (its reason is
//      recorded; a NEW refusal frame anywhere else reds §3);
//    split: 121 cols AND the viewport floor's rows (one owner: ink/viewportFloor);
//    chrome: cockpit 100×26 · deck 22 rows · inline below (the shed order);
//    overlays: viewportRows never manufactures rows.
//
//  Run: ~/.bun/bin/bun run scripts/ui/prove-size-ladder.ts
// ============================================================================
import { readdirSync, readFileSync, statSync } from 'node:fs'
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

// ── §1 the FACE operates at every size (and far below the ladder) ──────────
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

// ── §2 the MENU's ratified invariants at the shared sizes ──────────────────
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
    // The wide tier's panels (the ladder drives ≥110-col sizes through it).
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

// ── §3 the refusal-frame roster is CLOSED (warn > wall, ratified) ──────────
console.log('§3 the refusal-frame roster: the concourse alone, way out live')
{
  // A full-replacement refusal frame is lawful ONLY where degraded
  // operation is genuinely impossible (the reasons are
  // recorded). Today that roster is: the Session Concourse. A new
  // "too small" replacement frame anywhere else must come HERE with its
  // reason — or be built as works-degraded-with-warning instead.
  const offenders: string[] = []
  const walk = (dir: string): void => {
    for (const e of readdirSync(join(ROOT, dir))) {
      const rel = `${dir}/${e}`
      const st = statSync(join(ROOT, rel))
      if (st.isDirectory()) walk(rel)
      else if (/\.(ts|tsx)$/.test(e) && !/\.test\./.test(e)) {
        const src = readFileSync(join(ROOT, rel), 'utf8')
        if (/terminal too small|too small for/i.test(src)) offenders.push(rel)
      }
    }
  }
  for (const tree of ['src/components', 'src/screens']) walk(tree)
  const roster = new Set(['src/components/concourse/ConcourseLayout.tsx'])
  check(
    'every full-replacement refusal is on the registered roster',
    offenders.every(o => roster.has(o)),
    offenders.filter(o => !roster.has(o)).join(' · '),
  )
  const layout = read('src/components/concourse/ConcourseLayout.tsx')
  check('the registered refusal keeps its way out on the frame', layout.includes('esc returns to the focused chat') && layout.includes('esc returns to the boot face'))
  const { resolveConcourseProfile } = await import('../../src/components/concourse/ConcourseLayout.tsx')
  // The too-small floor IS the viewport floor (one owner): below it the
  // alternate-screen host paints the resize line, so a fitting window never
  // meets a too-small pane.
  const { VIEWPORT_FLOOR_COLS: FC, VIEWPORT_FLOOR_ROWS: FR } = await import('../../src/ink/viewportFloor.ts')
  check(
    `its boundary is the viewport floor: refuses at ${FC - 1}×${FR} and ${FC}×${FR - 1}, stands at ${FC}×${FR}`,
    resolveConcourseProfile(FC - 1, FR) === 'too-small' && resolveConcourseProfile(FC, FR - 1) === 'too-small' && resolveConcourseProfile(FC, FR) !== 'too-small',
  )
}

// ── §4 the frame laws: split · chrome · overlays ───────────────────────────
console.log('§4 split, chrome and overlay commitments hold at the ladder')
{
  const split = await import('../../src/components/concourse/splitView.ts')
  check(`split: 121×${split.SPLIT_MIN_ROWS} exactly (the rows floor is the viewport floor's)`, !split.splitAvailableAt(120, split.SPLIT_MIN_ROWS) && !split.splitAvailableAt(121, split.SPLIT_MIN_ROWS - 1) && split.splitAvailableAt(121, split.SPLIT_MIN_ROWS))
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
