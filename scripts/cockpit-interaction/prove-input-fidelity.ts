#!/usr/bin/env bun

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checker } from '../engine-durability/harness.ts'
import { vshotBudgetMs } from '../lib/captureDriver.ts'
import { spawnCaptureSync } from '../lib/spawnCapture.ts'

const t = checker()
const scratch = mkdtempSync(join(tmpdir(), 'hz-fid-'))

const BIN = 'dist/mercury.mjs'
if (!existsSync(BIN)) {
  t.check('dist exists (build first)', false, BIN)
} else {
  const home = join(scratch, 'pty-home')
  const FIXTURE_KEY = process.env.ANTHROPIC_API_KEY ?? 'sk-ant-fixture-fid'
  spawnSync(process.execPath, ['run', 'scripts/lib/firstRunSeed.ts', home, process.cwd()], {
    env: { ...process.env, ANTHROPIC_API_KEY: FIXTURE_KEY },
  })
  const out = join(scratch, 'fid.json')
  const EXPECT = 'alpha bravo charlie delta'
  const cfg = {
    cols: 120,
    rows: 40,
    total: 300,
    argv: ['node', BIN],
    out,
    cwd: process.cwd(),
    resizes: [{ cols: 100, rows: 40, afterMark: 'pre-resize', afterMs: 0 }],
    sends: [
      { atTick: 40, requireAwait: true, awaitText: '↑↓ choose', minTick: 3, awaitSettleTicks: 2, data: '\r' },
      { atTick: 60, requireAwait: true, awaitText: '? for shortcuts', minTick: 5, awaitSettleTicks: 3, data: 'alpha ' },
      { afterPrevTicks: 2, requireAwait: true, awaitText: '❯ alpha ', data: 'b' },
      { afterPrevTicks: 1, requireAwait: true, awaitText: '❯ alpha b', data: 'r' },
      { afterPrevTicks: 1, requireAwait: true, awaitText: '❯ alpha br', data: 'a' },
      { afterPrevTicks: 1, requireAwait: true, awaitText: '❯ alpha bra', data: 'v' },
      { afterPrevTicks: 1, requireAwait: true, awaitText: '❯ alpha brav', data: 'o' },
      { atTick: 999, requireAwait: true, awaitText: 'alpha bravo', minTick: 5, awaitSettleTicks: 2, data: '\u0018', mark: 'pre-overlay' },
      { afterPrevTicks: 2, requireAwait: true, awaitText: 'alpha bravo', awaitSettleTicks: 2, data: 'p' },
      { atTick: 999, requireAwait: true, awaitText: 'palette', minTick: 5, awaitSettleTicks: 2, data: '\u001b', mark: 'overlay-open' },
      { afterPrevTicks: 3, requireAwait: true, awaitText: '❯ alpha bravo', awaitPattern: '\\A(?![\\s\\S]*palette)', data: ' charlie' },
      { atTick: 200, requireAwait: true, awaitText: '❯ alpha bravo charlie', data: '', mark: 'pre-resize' },
      { atTick: 220, requireAwait: true, awaitText: 'alpha bravo charlie', awaitPattern: '\\A[^\\n]{100}\\n', minTick: 210, awaitSettleTicks: 2, data: ' delta' },
    ],
    readyText: EXPECT,
    readySettleTicks: 4,
  }
  const cfgPath = join(scratch, 'fid-cfg.json')
  writeFileSync(cfgPath, JSON.stringify(cfg))
  const r = spawnCaptureSync('/usr/bin/python3', ['scripts/ui/vshot.py', cfgPath], {
    env: {
      ...process.env,
      TERM: 'xterm-256color',
      MERCURY_CONFIG_DIR: home,
      ANTHROPIC_API_KEY: FIXTURE_KEY,
      MERCURY_BOOT_PREFLIGHT: '0',
      MERCURY_LIVE_GLYPHS: '0',
      MERCURY_HEALTH_STATE_DIR: join(scratch, 'doctor'),
      MERCURY_DAEMON_DIR: join(scratch, 'daemon'),
    },
    encoding: 'utf8',
    timeout: vshotBudgetMs(240_000),
  })
  type Cell = { c: string }
  let payload: { grid?: Cell[][]; marks?: Array<{ label: string; grid: Cell[][] }> } = {}
  try {
    payload = JSON.parse(readFileSync(out, 'utf8'))
  } catch {
  }
  const asLines = (g?: Cell[][]): string[] => (g ?? []).map(row => row.map(c => c.c).join(''))
  const composerLine = (lines: string[]): string => {
    for (let i = lines.length - 1; i >= 0; i--) {
      if (lines[i]?.includes('❯')) return lines[i]!
    }
    return ''
  }
  const finalLines = asLines(payload.grid)
  const composer = composerLine(finalLines)
  t.check('the journey completed (vshot exit 0)', r.status === 0, `exit=${r.status}`)
  t.check('the overlay really opened between the words', (payload.marks ?? []).some(m => m.label === 'overlay-open'))
  t.check(
    'FIDELITY: the composer equals the driven sequence exactly, at the new geometry',
    composer.includes(`❯ ${EXPECT}`),
    composer.trim() || '(no composer row)',
  )
  t.check(
    'no character lost or duplicated across the overlay or the resize',
    !/alpha  bravo|bbravo|bravoo|charliee|ddelta|charlie  delta/.test(finalLines.join('\n')) &&
      (composer.match(/alpha/g) ?? []).length === 1,
    'exact',
  )
  t.check(
    'the final frame is the post-resize geometry (100 cols)',
    (finalLines[0]?.length ?? 0) === 100,
    `width=${finalLines[0]?.length}`,
  )
}

rmSync(scratch, { recursive: true, force: true })
t.finish('prove-input-fidelity')
