#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { vshotBudgetMs } from '../lib/captureDriver.ts'

const REPO = join(import.meta.dir, '..', '..')
const BIN = join(REPO, 'dist', 'mercury.mjs')
const VSHOT = join(REPO, 'scripts', 'ui', 'vshot.py')
const OUT_DIR = process.env.PARITY_OUT_DIR ?? mkdtempSync(join(tmpdir(), 'look-parity-'))

let failures = 0
let checks = 0
function check(label: string, cond: boolean, detail = ''): void {
  checks++
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
const section = (t: string): void => console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))

const arg = (name: string): string | undefined => {
  const at = process.argv.indexOf(name)
  return at >= 0 ? process.argv[at + 1] : undefined
}
const CELLS = (arg('--cells') ?? '120x40,100x30').split(',').map(s => {
  const [c, r] = s.split('x').map(Number)
  return { cols: c!, rows: r! }
})
const THEMES = (arg('--themes') ?? 'dark,light').split(',')

console.log('============================================================')
console.log(' look parity — settled cockpit frames, engine ON vs OFF')
console.log(`  captures → ${OUT_DIR}`)
console.log('============================================================')

if (!process.argv.includes('--skip-build')) {
  const build = spawnSync(process.execPath, ['run', 'build.ts'], { cwd: REPO, encoding: 'utf8', timeout: 600_000 })
  check('dist rebuilt from this tree (stale-dist guard)', build.status === 0, (build.stderr ?? '').slice(-300))
}
if (!existsSync(BIN)) {
  check('dist/mercury.mjs exists', false)
  process.exit(1)
}

const { seedFirstRun } = await import('../lib/firstRunSeed.ts')
const { compactGrid, firstDivergence, DEFAULT_MASKS } = await import('../ui/visualBaseline.ts')
type RawGridT = Parameters<typeof compactGrid>[0]

const FIX = join(OUT_DIR, 'fixture-cwd')
mkdirSync(FIX, { recursive: true })
writeFileSync(join(FIX, 'README.md'), '# look-parity capture fixture\n')
const FIX_REAL = realpathSync(FIX)

type Leg = 'off' | 'on'
type Capture = { marks: Record<string, RawGridT>; final: RawGridT; ok: boolean; detail: string }

function capture(cols: number, rows: number, theme: string, leg: Leg): Capture {
  const tag = `${cols}x${rows}-${theme}-${leg}`
  const home = join(OUT_DIR, `home-${tag}`)
  process.env.ANTHROPIC_API_KEY = 'proof-key-scripted-stream'
  seedFirstRun(home, [FIX, FIX_REAL])
  const cfgFile = join(home, '.mercury.json')
  const cfg = JSON.parse(readFileSync(cfgFile, 'utf8')) as Record<string, unknown>
  cfg.theme = theme
  writeFileSync(cfgFile, JSON.stringify(cfg, null, 2))
  writeFileSync(
    join(home, 'settings.json'),
    JSON.stringify({ prefersReducedMotion: true, spinnerTipsEnabled: false }),
  )
  writeFileSync(
    join(home, 'critter-profile.json'),
    JSON.stringify({
      v: 1,
      seed: '00000000-0000-4000-8000-00000000c0de',
      createdAt: 1_787_600_000_000,
      milestones: { settles: 0, recoveries: 0 },
      quiet: true,
      seenTips: {},
      openedSurfaces: [],
    }),
  )

  const gridPath = join(OUT_DIR, `grid-${tag}.json`)
  const vshotCfg = join(OUT_DIR, `vshot-${tag}.json`)
  writeFileSync(
    vshotCfg,
    JSON.stringify({
      argv: ['node', BIN],
      cwd: FIX,
      cols,
      rows,
      total: 220,
      sends: [
        { atTick: 999, requireAwait: true, awaitText: '↑↓ choose', minTick: 3, awaitSettleTicks: 2, data: '\r' },
        { atTick: 999, requireAwait: true, awaitText: 'Type a prompt', minTick: 5, awaitSettleTicks: 4, data: '', mark: 'idle' },
        { afterPrevTicks: 1, data: 'parity drive prompt' },
        { afterPrevTicks: 2, data: '\r' },
        { atTick: 999, requireAwait: true, awaitText: 'Scripted stream settled', minTick: 20, awaitSettleTicks: 4, data: '', mark: 'settled' },
      ],
      out: gridPath,
    }),
  )
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    ANTHROPIC_API_KEY: 'proof-key-scripted-stream',
    MERCURY_SCRIPTED_STREAM: 'slow-text',
    MERCURY_LIVE_GLYPHS: '0',
    MERCURY_CRITTER_GAZE: '0',
    MERCURY_TURN_RECEIPT: '0',
    MERCURY_TABULA_MINERVA: '0',
    MERCURY_CONFIG_DIR: home,
    MERCURY_DAEMON_DIR: join(OUT_DIR, `daemon-${tag}`),
    MERCURY_TEAMS_DIR: join(OUT_DIR, `teams-${tag}`),
    MERCURY_TABULA_DIR: join(OUT_DIR, `tabula-${tag}`),
    MERCURY_HOME: join(OUT_DIR, `mhome-${tag}`),
    VISUAL: '',
    EDITOR: '',
  }
  delete env.MERCURY_RENDER_ENGINE
  delete env.MERCURY_ENGINE_ASSERT
  if (leg === 'on') {
    env.MERCURY_RENDER_ENGINE = '1'
    env.MERCURY_ENGINE_ASSERT = '1'
  }
  const res = spawnSync('/usr/bin/python3', [VSHOT, vshotCfg], { encoding: 'utf8', timeout: vshotBudgetMs(240_000), env })
  if (res.status !== 0) {
    return { marks: {}, final: { cols, rows, grid: [] }, ok: false, detail: (res.stderr ?? '').slice(-400) }
  }
  const payload = JSON.parse(readFileSync(gridPath, 'utf8')) as {
    grid: RawGridT['grid']
    marks?: Array<{ label: string; grid: RawGridT['grid'] }>
    endReason?: string
  }
  const marks: Record<string, RawGridT> = {}
  for (const m of payload.marks ?? []) marks[m.label] = { cols, rows, grid: m.grid }
  return { marks, final: { cols, rows, grid: payload.grid }, ok: true, detail: payload.endReason ?? '' }
}

const gridText = (g: RawGridT): string => g.grid.map(r => r.map(c => c.c).join('')).join('\n')

for (const { cols, rows } of CELLS) {
  for (const theme of THEMES) {
    section(`${cols}x${rows} · ${theme}`)
    const off = capture(cols, rows, theme, 'off')
    check(`OFF capture ran (${cols}x${rows} ${theme})`, off.ok, off.detail)
    const on = capture(cols, rows, theme, 'on')
    check(`ON capture ran (${cols}x${rows} ${theme})`, on.ok, on.detail)
    if (!off.ok || !on.ok) continue

    for (const mark of ['idle', 'settled']) {
      check(`both legs reached the '${mark}' instant`, mark in off.marks && mark in on.marks, `off=${Object.keys(off.marks)} on=${Object.keys(on.marks)}`)
    }
    check('the settled reply text is on screen (OFF)', gridText(off.final).includes('Scripted stream settled'))
    check('the settled reply text is on screen (ON)', gridText(on.final).includes('Scripted stream settled'))

    const instants: Array<[string, RawGridT | undefined, RawGridT | undefined]> = [
      ['idle', off.marks.idle, on.marks.idle],
      ['settled', off.marks.settled, on.marks.settled],
      ['final', off.final, on.final],
    ]
    for (const [name, a, b] of instants) {
      if (!a || !b) continue
      const d = firstDivergence(compactGrid(a), compactGrid(b), DEFAULT_MASKS)
      check(
        `${name}: settled frame byte-identical ON vs OFF (glyphs + styles, baseline masks)`,
        d === null,
        d ? `first divergence row ${d.row} col ${d.col} (${d.kind}): ${d.old} vs ${d.new}\n      OFF: ${JSON.stringify(d.oldRow)}\n      ON : ${JSON.stringify(d.newRow)}` : '',
      )
    }
  }
}

console.log(`\n${failures === 0 ? `ALL GREEN (${checks} checks)` : `${failures} FAILURE(S) of ${checks}`}`)
console.log(`captures kept at ${OUT_DIR}`)
process.exit(failures === 0 ? 0 : 1)
