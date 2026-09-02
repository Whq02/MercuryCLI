#!/usr/bin/env bun
import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  cellColor,
  CR_COLS,
  CRITTERS,
  decideCritterForm,
  HERO_ART_COLS,
  critterDefForKey,
} from '../../src/utils/cockpit/critterData.js'
import { berthCritterCols, berthCritterForm } from '../../src/components/MercuryHome.js'
import { setSessionCritter } from '../../src/components/mercury-ui/sessionAccent.js'
import { CONFIG_HOME, scenario } from '../ui/renderScenarios.ts'
import { vshotBudgetMs } from '../lib/captureDriver.ts'

let failures = 0
const t = (name: string, ok: boolean, detail = ''): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures = 1
}
const REPO = join(import.meta.dir, '..', '..')
const read = (p: string) => readFileSync(join(REPO, p), 'utf8')
const norm = (c: unknown): string => String(c ?? '').replace('#', '').toLowerCase()

{
  const home = read('src/components/MercuryHome.tsx')
  const berth = home.slice(home.indexOf('export function PinnedCritterBerth'))
  const berthBody = berth.slice(0, berth.indexOf('\n}'))
  t('berth passes hero= to AnimatedCritterArt', /AnimatedCritterArt[^/]*hero=\{heroFits\}/.test(berthBody))
  t('berth floors through the ONE form decision (decideCritterForm over allocated cells)',
    berthBody.includes('decideCritterForm({ columns, rows }') &&
    berthBody.includes("form === 'hero' || form === 'premium-compact'"))
  const layout = read('src/components/FullscreenLayout.tsx')
  t('the statusBand card mounts PinnedCritterBerth', layout.includes('<PinnedCritterBerth />'))
}

{
  const heroCritter = [...CRITTERS].find(c => c.heroArt?.length)
  const flatCritter = [...CRITTERS].find(c => !c.heroArt?.length)
  t('a hero-art critter exists for the matrix', heroCritter !== undefined)
  const matrixCols = [CR_COLS + 1, CR_COLS + 2, HERO_ART_COLS + 3, HERO_ART_COLS + 4, 120]
  const matrixRows = [22, 29, 30, 31, 46]
  const tiers = new Set(['hero', 'premium-compact'])
  if (heroCritter) {
    setSessionCritter(heroCritter.key)
    let drift = ''
    for (const c of matrixCols) {
      for (const r of matrixRows) {
        const owner = decideCritterForm({ columns: c, rows: r }, true)
        const mirror = berthCritterForm(c, r)
        const cols = berthCritterCols(c, r)
        if (mirror !== owner) drift ||= `form@${c}x${r}: ${mirror}≠${owner}`
        if (cols !== (tiers.has(owner) ? HERO_ART_COLS : 13)) drift ||= `cols@${c}x${r}: ${cols}`
      }
    }
    t(`${heroCritter.name}: mirror ≡ owner across the floor matrix (form, width)`, drift === '', drift)
  }
  if (flatCritter) {
    setSessionCritter(flatCritter.key)
    let drift = ''
    for (const c of matrixCols) {
      for (const r of matrixRows) {
        const owner = decideCritterForm({ columns: c, rows: r }, false)
        if (berthCritterForm(c, r) !== owner) drift ||= `form@${c}x${r}`
        if (berthCritterCols(c, r) !== 13) drift ||= `cols@${c}x${r}: ${berthCritterCols(c, r)}`
      }
    }
    t(`${flatCritter.name}: no hero art ⇒ the mirror never grants hero width`, drift === '', drift)
  }
  const home = read('src/components/MercuryHome.tsx')
  t('berthCritterForm delegates to decideCritterForm (VP-01/02: ONE owner, never a re-derivation)',
    /export function berthCritterForm[\s\S]{0,400}?return decideCritterForm\(/.test(home) &&
    !/PREMIUM_COMPACT_MIN_ROWS|BERTH_HERO_MIN_ROWS|rows >= 30/.test(home))
  t('the berth RENDERER takes the same decision, not a private gate',
    /const form = decideCritterForm\(/.test(home))
  setSessionCritter('crab')
}

const ALL = [...CRITTERS]
for (const def of ALL) {
  t(`${def.name}: flat art carries NO 'K' (oracle stays sound)`, !def.art.some(r => r.includes('K')))
  if (def.heroArt?.length) {
    t(`${def.name}: heroArt carries 'K' pupils`, def.heroArt.some(r => r.includes('K')))
  }
}

type GridCell = { c: string; fg: string; bg: string }
type Grid = { grid: GridCell[][] }

function capture(tag: string): Grid {
  const cfg = scenario('resume-2turn', 120, 44)
  const out = `/tmp/berth-hero-${tag}-${process.pid}.json`
  const cfgPath = `/tmp/berth-hero-${tag}-cfg-${process.pid}.json`
  writeFileSync(cfgPath, JSON.stringify({ argv: cfg.argv, sends: [], total: 55, cols: 120, rows: 44, out }))
  const res = spawnSync('/usr/bin/python3', [join(import.meta.dir, '..', 'ui', 'vshot.py'), cfgPath], {
    encoding: 'utf8',
    timeout: vshotBudgetMs(120_000),
    env: {
      ...process.env,
      MERCURY_AWAY_SUMMARY: '0',
      MERCURY_CRITTER: 'crab',
      MERCURY_CONFIG_DIR: CONFIG_HOME,
    },
  })
  if (res.status !== 0) throw new Error(`vshot failed: ${res.stderr?.slice(0, 300)}`)
  return JSON.parse(readFileSync(out, 'utf8')) as Grid
}

const PUPIL_HEX = norm(cellColor(critterDefForKey('crab'), 'K'))

function pupilCellsInBerthRegion(g: Grid): number {
  let hits = 0
  const rows = Math.min(14, g.grid.length)
  for (let y = 0; y < rows; y++) {
    for (const cell of g.grid[y]!) {
      if (norm(cell.bg) === PUPIL_HEX || norm(cell.fg) === PUPIL_HEX) hits++
    }
  }
  return hits
}

{
  let hits = pupilCellsInBerthRegion(capture('a'))
  if (hits === 0) {
    hits = pupilCellsInBerthRegion(capture('b'))
  }
  t('cockpit berth renders the HERO grid (K-pupil mix on screen, top region)', hits > 0, `pupil cells=${hits}`)
}

console.log(failures === 0 ? '✅ berth-hero contract holds' : '❌ berth-hero contract BROKEN')
process.exit(failures)
