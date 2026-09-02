#!/usr/bin/env bun

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checker } from '../engine-durability/harness.ts'
import {
  critterDefForKey,
  DEFAULT_CRITTER_KEY,
  isPoolCritterKey,
} from '../../src/utils/cockpit/critterData.ts'
import { CRAB_GLYPHS } from '../../src/components/mercury-ui/assets.tsx'
import { displayWidth } from '../../src/components/mercury-ui/glyphs.ts'
import { vshotBudgetMs } from '../lib/captureDriver.ts'

const t = checker()
const KEYS = ['crab', 'octopus', 'jellyfish', 'clam'] as const
const BLOCKS = new Set('▖▗▘▝▙▟▛▜▚▞▀▄▆█'.split(''))

t.section('§1 — every registered critter authors a distinct 5-cell mark')
{
  const seen = new Map<string, string>()
  for (const k of KEYS) {
    const def = critterDefForKey(k)
    const s = def.mark.pre + def.mark.core + def.mark.post
    t.check(`${k} authors a width-5 mark`, displayWidth(s) === 5, `${s} (w=${displayWidth(s)})`)
    t.check(
      `${k} mark stays in the block-glyph family`,
      [...s].every(ch => BLOCKS.has(ch)),
      s,
    )
    t.check(
      `${k} mark is distinct`,
      !seen.has(s),
      seen.has(s) ? `collides with ${seen.get(s)}` : 'unique',
    )
    seen.set(s, k)
  }
  t.check(
    'an unknown key resolves to the pool default (never a crash, never blank)',
    critterDefForKey('seahorse').name === critterDefForKey(DEFAULT_CRITTER_KEY).name,
    critterDefForKey('seahorse').name,
  )
  for (const dead of ['dragon', 'hermit', 'hermit crab']) {
    t.check(
      `the retired key '${dead}' takes the bounded fallback to the pool default`,
      critterDefForKey(dead).name === critterDefForKey(DEFAULT_CRITTER_KEY).name &&
        !isPoolCritterKey(dead),
      critterDefForKey(dead).name,
    )
  }
  for (const legacy of ['mantis', 'mantis shrimp']) {
    t.check(
      `the retired spelling '${legacy}' resolves to the clam (its successor), not the default`,
      critterDefForKey(legacy).name === 'clam' && !isPoolCritterKey(legacy),
      critterDefForKey(legacy).name,
    )
  }
}

t.section('§2 — crab byte-identity (the amendment changes NOTHING for crab)')
{
  const m = critterDefForKey('crab').mark
  t.check(
    'crab mark === CRAB_GLYPHS, byte for byte',
    m.pre + m.core + m.post === CRAB_GLYPHS,
    `${m.pre}${m.core}${m.post} vs ${CRAB_GLYPHS}`,
  )
}

t.section('§3 — the session-identity slots render the SESSION mark')
{
  const frame = readFileSync('src/components/MercuryFrame.tsx', 'utf8')
  t.check('the statusline anchor is <SessionMark/>', frame.includes('<SessionMark />'), 'statusRow')
  const frameCode = frame
    .split('\n')
    .map(l => l.replace(/\/\/.*$/, ''))
    .join('\n')
  t.check(
    'the statusline no longer hardcodes <Crab/>',
    !/<Crab\s*\/>/.test(frameCode),
    'no literal crab render in the frame',
  )
  const exit = readFileSync('src/components/MercuryExitConfirm.tsx', 'utf8')
  t.check('the exit farewell is <SessionMark/>', exit.includes('<SessionMark />'), 'farewell')
}

t.section('§4 — the product lockup stays the true crab')
{
  for (const f of [
    'src/components/MercurySetupFrame.tsx',
    'src/components/mercury-ui/components.tsx',
    'src/components/MercuryWelcome.tsx',
  ]) {
    const src = readFileSync(f, 'utf8')
    t.check(`${f.split('/').pop()} keeps the crab lockup`, /<Crab\s*\/>/.test(src), 'product mark')
  }
}

t.section('§5 — REAL BINARY: an octopus session anchors with the octopus mark')
{
  const BIN = 'dist/mercury.mjs'
  if (!existsSync(BIN)) {
    t.check('dist exists (build first)', false, BIN)
  } else {
    const scratch = mkdtempSync(join(tmpdir(), 'mercury-critter-mark-'))
    const home = join(scratch, 'home')
    const FIXTURE_KEY = process.env.ANTHROPIC_API_KEY ?? 'sk-ant-fixture-critter-mark'
    spawnSync(process.execPath, ['run', 'scripts/lib/firstRunSeed.ts', home, process.cwd()], {
      env: { ...process.env, ANTHROPIC_API_KEY: FIXTURE_KEY },
    })
    const out = join(scratch, 'g.json')
    const cfg = {
      cols: 100, rows: 30, total: 90,
      argv: ['node', BIN], out, cwd: process.cwd(),
      sends: [{ atTick: 40, awaitText: '↑↓ choose', minTick: 3, awaitSettleTicks: 2, data: '\r' }],
      readyText: ['❯', '? for shortcuts'], readySettleTicks: 3,
    }
    const cfgPath = join(scratch, 'c.json')
    writeFileSync(cfgPath, JSON.stringify(cfg))
    const r = spawnSync('/usr/bin/python3', ['scripts/ui/vshot.py', cfgPath], {
      env: {
        ...process.env,
        TERM: 'xterm-256color',
        MERCURY_CONFIG_DIR: home,
        ANTHROPIC_API_KEY: FIXTURE_KEY,
        MERCURY_BOOT_PREFLIGHT: '0',
        MERCURY_LIVE_GLYPHS: '0',
        MERCURY_CRITTER: 'octopus',
        MERCURY_DOCTOR_STATE_DIR: join(scratch, 'doctor'),
        MERCURY_DAEMON_DIR: join(scratch, 'daemon'),
      },
      encoding: 'utf8',
      timeout: vshotBudgetMs(120_000),
    })
    let text = ''
    try {
      const payload = JSON.parse(readFileSync(out, 'utf8')) as { grid: Array<Array<{ c: string }>> }
      text = payload.grid.map(row => row.map(c => c.c).join('')).join('\n')
    } catch {
    }
    const octo = critterDefForKey('octopus').mark
    const octoMark = octo.pre + octo.core + octo.post
    t.check('the capture settled', r.status === 0, `exit=${r.status}`)
    t.check(`the statusrow anchors with the octopus mark ${octoMark}`, text.includes(octoMark), 'found')
    const crabCount = text.split(CRAB_GLYPHS).length - 1
    t.check(
      'zero crab marks anywhere in an octopus session (any appearance is a reverted slot)',
      crabCount === 0,
      `${crabCount} crab mark(s)`,
    )
    rmSync(scratch, { recursive: true, force: true })
  }
}

t.finish('prove-critter-mark')
