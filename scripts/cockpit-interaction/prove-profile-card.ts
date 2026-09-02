#!/usr/bin/env bun

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checker } from '../engine-durability/harness.ts'
import { vshotBudgetMs } from '../lib/captureDriver.ts'

const t = checker()
const REPO = join(import.meta.dir, '..', '..')
const VSHOT = join(REPO, 'scripts', 'ui', 'vshot.py')
const BIN = join(REPO, 'dist', 'mercury.mjs')

if (!existsSync(BIN)) {
  t.check('dist/mercury.mjs exists (build first)', false, BIN)
  t.finish('prove-profile-card')
}

const scratch = mkdtempSync(join(tmpdir(), 'mercury-profile-card-'))
const home = join(scratch, 'home')
const FIXTURE_KEY = process.env.ANTHROPIC_API_KEY ?? 'sk-ant-fixture-profile-card'
spawnSync(process.execPath, ['run', join(REPO, 'scripts', 'lib', 'firstRunSeed.ts'), home, REPO], {
  cwd: REPO,
  env: { ...process.env, ANTHROPIC_API_KEY: FIXTURE_KEY },
})

interface Grid {
  grid: Array<Array<{ c: string }>>
  endReason: string
}
function capture(
  name: string,
  term: string,
  cfgExtra: Record<string, unknown>,
): { text: string; exit: number; endReason: string } {
  const out = join(scratch, `${name}.grid.json`)
  const cfg = {
    cols: 100,
    rows: 32,
    total: 90,
    argv: [process.env.NODE ?? 'node', BIN],
    out,
    cwd: REPO,
    ...cfgExtra,
  }
  const cfgPath = join(scratch, `${name}.cfg.json`)
  writeFileSync(cfgPath, JSON.stringify(cfg))
  const r = spawnSync('/usr/bin/python3', [VSHOT, cfgPath], {
    cwd: REPO,
    env: {
      ...process.env,
      TERM: term,
      MERCURY_CONFIG_DIR: home,
      ANTHROPIC_API_KEY: FIXTURE_KEY,
      MERCURY_BOOT_PREFLIGHT: '0',
      MERCURY_LIVE_GLYPHS: '0',
      MERCURY_DOCTOR_STATE_DIR: join(scratch, 'doctor'),
      MERCURY_DAEMON_DIR: join(scratch, 'daemon'),
    },
    encoding: 'utf8',
    timeout: vshotBudgetMs(120_000),
  })
  let text = ''
  let endReason = 'missing'
  try {
    const payload = JSON.parse(readFileSync(out, 'utf8')) as Grid
    text = payload.grid.map(row => row.map(c => c.c).join('')).join('\n')
    endReason = payload.endReason
  } catch {
  }
  return { text, exit: r.status ?? -1, endReason }
}

t.section('leg 1 — TERM=dumb boots the requirement card, not the cockpit')
{
  const r = capture('card', 'dumb', { readyText: 'terminal check', readySettleTicks: 3 })
  t.check('capture settled on the card (never-ready would exit 3)', r.exit === 0, `exit=${r.exit} end=${r.endReason}`)
  t.check('the TERMINAL CHECK title paints', r.text.includes('terminal check'), 'title')
  t.check(
    'the failing required row names itself',
    r.text.includes('cursor-addressable terminal'),
    'row label',
  )
  t.check('the evidence names the dumb TERM', r.text.includes('TERM=dumb'), 'evidence')
  t.check(
    'the explicit choice is on screen',
    r.text.includes('Exit — relaunch in a supported terminal') &&
      r.text.includes('Continue anyway'),
    'choices',
  )
  t.check('the card wears the setup frame (step rail present)', r.text.includes('terminal · 1/1'), 'stepTag')
}

t.section('leg 2 — Exit leaves the guidance, not a cockpit')
{
  const r = capture('exit', 'dumb', {
    sends: [{ atTick: 40, awaitText: 'Exit — relaunch', minTick: 5, awaitSettleTicks: 2, data: '\r' }],
    stableTicks: 4,
    total: 90,
  })
  t.check('the exit guidance line paints', r.text.includes('missing required capabilities'), 'guidance')
}

t.section('leg 3 — CONTROL: a capable TERM boots straight to the composer')
{
  const r = capture('control', 'xterm-256color', {
    sends: [{ atTick: 40, awaitText: '↑↓ choose', minTick: 3, awaitSettleTicks: 2, data: '\r' }],
    readyText: ['❯', '? for shortcuts'],
    readySettleTicks: 3,
  })
  t.check('the composer paints', r.exit === 0 && r.text.includes('❯'), `exit=${r.exit} end=${r.endReason}`)
  t.check('the card never fires on a supported host', !r.text.includes('terminal check'), 'no card')
}

rmSync(scratch, { recursive: true, force: true })
t.finish('prove-profile-card')
