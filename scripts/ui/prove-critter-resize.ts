#!/usr/bin/env bun
import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { compactGrid, readManifest, readStoredGrid, type RawGrid } from './visualBaseline.ts'
import { vshotBudgetMs } from '../lib/captureDriver.ts'

const RUN_HOME = join(tmpdir(), `critter-resize-home-${process.pid}`)
rmSync(RUN_HOME, { recursive: true, force: true })
mkdirSync(RUN_HOME, { recursive: true })
const REPO = join(import.meta.dir, '..', '..')
writeFileSync(
  join(RUN_HOME, '.claude.json'),
  JSON.stringify({
    hasCompletedOnboarding: true,
    lastOnboardingVersion: '99.0.0',
    numStartups: 10,
    theme: 'dark',
    projects: { [REPO]: { hasTrustDialogAccepted: true } },
    ...(process.env.ANTHROPIC_API_KEY
      ? { customApiKeyResponses: { approved: [process.env.ANTHROPIC_API_KEY.slice(-20)], rejected: [] } }
      : {}),
  }),
)
writeFileSync(join(RUN_HOME, 'settings.json'), JSON.stringify({}))
process.env.MERCURY_CONFIG_DIR = RUN_HOME
const { scenario, cleanupScenario } = await import('./renderScenarios.ts')

let fail = 0
const t = (name: string, ok: boolean, detail = ''): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) fail = 1
}

const cfg = scenario('frame', 120, 40) as Record<string, unknown>
const gridPath = join(tmpdir(), `critter-resize-${process.pid}.json`)
const cfgPath = join(tmpdir(), `critter-resize-cfg-${process.pid}.json`)
writeFileSync(
  cfgPath,
  JSON.stringify({
    ...cfg,
    out: gridPath,
    total: 110,
    readyText: '❯ first task',
    readySettleTicks: 3,
    resizes: [
      { atTick: 25, cols: 60, rows: 18 },
      { atTick: 38, cols: 120, rows: 40 },
    ],
  }),
)
const res = spawnSync('/usr/bin/python3', [join(import.meta.dir, 'vshot.py'), cfgPath], {
  encoding: 'utf-8',
  timeout: vshotBudgetMs(90_000),
  env: { ...process.env, MERCURY_CONFIG_DIR: RUN_HOME, MERCURY_AWAY_SUMMARY: '0' },
})
cleanupScenario('frame')
rmSync(RUN_HOME, { recursive: true, force: true })
if (res.status !== 0) {
  console.log(`FAIL  capture ran — ${res.stderr?.slice(0, 300)}`)
  process.exit(1)
}
const payload = JSON.parse(readFileSync(gridPath, 'utf8')) as RawGrid & {
  stages?: Array<{ cols: number; rows: number; grid: RawGrid['grid'] }>
}

const frames: Array<{ name: string; cols: number; rows: number; grid: RawGrid['grid'] }> = [
  ...(payload.stages ?? []).map((s, i) => ({ name: `stage${i} (${s.cols}x${s.rows})`, cols: s.cols, rows: s.rows, grid: s.grid })),
  { name: 'final (120x40)', cols: payload.cols, rows: payload.rows, grid: payload.grid },
]
t('resize stages captured', (payload.stages?.length ?? 0) === 2, `${payload.stages?.length ?? 0}`)

for (const f of frames) {
  const text = f.grid.map(row => row.map(c => c.c).join(''))
  const wordmarkRows = text.filter(r => r.includes('█▄▄▄█')).length
  const lockups = text.filter(r => r.includes('✶ Mercury')).length
  const brands = (wordmarkRows > 0 ? 1 : 0) + lockups
  t(`${f.name}: single brand (wordmark rows=${wordmarkRows}, lockups=${lockups})`, brands <= 1)
  const ink = text.reduce((n, r) => n + r.trim().length, 0)
  t(`${f.name}: not blank`, ink > 40, `${ink} ink chars`)
}

const manifest = readManifest()
const baselineEntry = manifest?.entries.find(e => e.id === 'frame--120x40--dark--truecolor--full')
if (!baselineEntry) {
  t('baseline entry present', false)
} else {
  const baseline = readStoredGrid(baselineEntry)
  const finalGrid = compactGrid({ cols: payload.cols, rows: payload.rows, grid: payload.grid })
  const bText = baseline.text
  const fText = finalGrid.text
  const bArt = bText.filter(r => /[▀▄]{3,}/.test(r)).length
  const fArt = fText.filter(r => /[▀▄]{3,}/.test(r)).length
  t('round-trip art-row count equals the fresh-boot baseline', fArt === bArt, `fresh=${bArt} roundtrip=${fArt}`)
  const bBrand = bText.filter(r => r.includes('█▄▄▄█')).length
  const fBrand = fText.filter(r => r.includes('█▄▄▄█')).length
  t('round-trip wordmark rows equal the baseline', fBrand === bBrand, `fresh=${bBrand} roundtrip=${fBrand}`)
}

if (fail) {
  console.log('\n❌ critter-resize — failures above (the duplication repro?)')
  process.exit(1)
}
console.log('\n✅ critter-resize — minimize→maximize round-trip is single-brand and art-stable')
